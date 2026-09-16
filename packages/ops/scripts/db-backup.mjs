#!/usr/bin/env node
/**
 * db-backup：数据库自动备份（P7 B2，t12 设计 §2）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run db-backup [--root <BACKUP_ROOT>] [--parallel N] [--force]
 *
 * 范围：共享库 teacher_platform + TeacherRegistry 枚举的全部教师库，逐库独立
 * pg_dump -Fc -Z 9；每库双校验（sha256 + pg_restore -l）；失败 collect 继续；
 * 结束生成 MANIFEST JSON + 轮转清理；failed>0 → exit 非 0。
 *
 * 安全：库名逐项 assertSafeTeacherDatabaseName / 共享库白名单；本地 host 红线
 * （assertSafeBaseUrl）；维护连接 PGDATABASE=postgres 做存在性预检；备份文件 0600。
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeBaseUrl,
  assertSafeTeacherDatabaseName,
  SHARED_DB_NAME,
} from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  projectRoot,
  psqlEnvironment,
  psqlMaintenance,
  psqlQuery,
  quoteLiteral,
  run,
  withDatabase,
  withPostgresBinPath,
} from '../lib/pg-utils.mjs';
import { createLocalDirStorage } from '../lib/storage-backend.mjs';
import { applyRetention } from '../lib/retention.mjs';

const DEFAULT_BACKUP_ROOT = process.env.BACKUP_ROOT
  ?? (process.platform === 'win32'
    ? `${process.env.TEMP || 'C:/Windows/Temp'}/teacher-platform-backups`
    : '/var/backups/teacher-platform');
const SHARED_DB = SHARED_DB_NAME;
const DUMP_NAME_PATTERN = /^[a-z0-9_]+_\d{8}-\d{6}\.dump$/;

export function parseArgs(argv) {
  const args = { root: DEFAULT_BACKUP_ROOT, parallel: 1, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--parallel') args.parallel = Number(argv[++i]);
    else if (arg === '--force') args.force = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 8) {
    throw new Error('--parallel 必须是 1..8 的整数');
  }
  if (!args.root) throw new Error('--root 不能为空');
  return args;
}

/** 媒体存储根（MEDIA_STORAGE_ROOT env 优先；缺省 monorepo 根 .data——与后端 createStorage 同根约定）。 */
export function resolveMediaRoot() {
  return process.env.MEDIA_STORAGE_ROOT
    ? resolve(process.env.MEDIA_STORAGE_ROOT)
    : resolve(projectRoot, '.data');
}

/** 将既有本地备份树收紧为目录 0700、普通文件 0600；权限失败即中止，绝不假绿。 */
export async function hardenBackupPermissions(root) {
  const absoluteRoot = resolve(root);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  await chmod(absoluteRoot, 0o700);

  async function hardenDirectory(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    await chmod(directory, 0o700);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await hardenDirectory(path);
      else if (entry.isFile()) await chmod(path, 0o600);
    }
  }

  await hardenDirectory(resolve(absoluteRoot, 'daily'));
  await hardenDirectory(resolve(absoluteRoot, 'monthly'));
}

/**
 * 收集媒体文件清单（P8 t8 缺口1修复）：.data/media/<teacherId>/ 递归文件 path+sha256+sizeBytes。
 * .data/media 不存在 → { exists:false, files:[] }（段为空不失败）。
 * 保留策略：媒体备份副本 7d daily / 12m monthly 与库备份同构（原文件为 .data 活数据，随应用保留）。
 */
export async function collectMediaManifest(mediaRoot) {
  const mediaDir = resolve(mediaRoot, 'media');
  if (!existsSync(mediaDir)) {
    return { exists: false, files: [] };
  }
  const { readFile } = await import('node:fs/promises');
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        // P15 t1：并发写/删除的媒体文件读失败（ENOENT/EPERM 瞬态）→ 跳过该文件（备份不因竞态崩）
        try {
          const content = await readFile(full);
          files.push({
            path: relative(mediaRoot, full).split('\\').join('/'),
            sha256: createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length,
          });
        } catch {
          // 瞬态读失败：跳过（活数据区文件，备份段缺一条可接受；下轮备份会重读）
        }
      }
    }
  }
  await walk(mediaDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { exists: true, files };
}

/** 生成备份文件名 <databaseName>_<YYYYMMDD>-<HHMMSS>.dump（本地时钟，UTC）。 */
export function buildDumpFileName(databaseName, now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${databaseName}_${stamp}.dump`;
}

/**
 * 枚举备份目标库：共享库 + TeacherRegistry 教师库（distinct 非空，逐项校验）。
 * 过渡态教师（未建独立库）databaseName 默认为共享库 teacher_platform——该行跳过
 * （共享库已单独 dump 覆盖），只对独立教师库做 assertSafeTeacherDatabaseName。
 * P15 t1：psql 瞬态失败（全量负载下连接/进程耗尽）重试 2 次。
 */
export function enumerateBackupDatabases(sourceUrl, sourceDatabaseName) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const rows = psqlQuery(
        sourceUrl,
        SHARED_DB,
        'SELECT DISTINCT "databaseName" FROM "TeacherRegistry" WHERE "databaseName" IS NOT NULL AND "databaseName" <> \'\' ORDER BY "databaseName"',
      );
      const teacherDbs = rows.filter((name) => name !== SHARED_DB);
      teacherDbs.forEach((name) => assertSafeTeacherDatabaseName(name, sourceDatabaseName));
      return [SHARED_DB, ...teacherDbs];
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        process.stdout.write(`[retry] 枚举备份库失败（${error.message}），${attempt + 1}/2 次重试\n`);
        // 同步上下文：用 Atomics.wait 做短退避（0.3s）
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      }
    }
  }
  throw lastError;
}

/** 单库 dump 一次（pg_dump -Fc -Z 9 → sha256 → pg_restore -l 校验）。 */
async function dumpOneDatabaseOnce(sourceUrl, databaseName, runId, fileName) {
  const targetUrl = withDatabase(sourceUrl, databaseName);
  const env = withPostgresBinPath(psqlEnvironment(targetUrl, databaseName));

  // pg_dump 不接受 URL 查询参数（如 ?schema=public），去掉 query/hash 再传。
  const dumpUrl = new URL(targetUrl.toString());
  dumpUrl.search = '';
  dumpUrl.hash = '';

  // 先以 0600 创建/截断目标，再交给 pg_dump 写入，避免默认 umask 产生 0644 暴露窗口。
  const privateDump = await open(fileName, 'w', 0o600);
  await privateDump.close();
  await chmod(fileName, 0o600);
  const result = run('pg_dump', ['-Fc', '-Z', '9', '-f', fileName, '-d', dumpUrl.toString()], {
    env: { ...env, PGDATABASE: databaseName },
  });
  // pg_dump 成功或失败都可能留下文件；校验/返回前再次 fail-closed 收紧。
  await chmod(fileName, 0o600);
  if (result.error || result.status !== 0) {
    return {
      name: databaseName, file: null, bytes: 0, sha256: null,
      pgRestoreListOk: false, status: 'failed',
      error: (result.error?.message ?? result.stderr?.trim() ?? 'pg_dump failed').split('\n')[0],
    };
  }

  const fileStat = await stat(fileName);
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(fileName);
  const sha256 = createHash('sha256').update(content).digest('hex');

  let pgRestoreListOk = false;
  const listResult = run('pg_restore', ['-l', fileName], {
    env: withPostgresBinPath(process.env),
  });
  if (listResult.error || listResult.status !== 0) {
    return {
      name: databaseName, file: fileName, bytes: fileStat.size, sha256,
      pgRestoreListOk: false, status: 'failed',
      error: (listResult.error?.message ?? 'pg_restore -l failed').split('\n')[0],
    };
  }
  const listOutput = listResult.stdout?.trim() ?? '';
  pgRestoreListOk = listOutput.length > 0;

  return {
    name: databaseName,
    file: fileName,
    bytes: fileStat.size,
    sha256,
    pgRestoreListOk,
    status: pgRestoreListOk ? 'ok' : 'failed',
    error: pgRestoreListOk ? undefined : 'pg_restore -l 输出为空（dump 损坏）',
  };
}

/** 短暂 sleep（重试退避）。 */
function sleepBackoff(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * 单库 dump 带瞬态失败重试（P15 t1：全量负载下 pg_dump/spawn 偶发瞬态失败——
 * 并发写导致的 serialization 错误 / Windows 进程/句柄耗尽 EMFILE / 瞬态连接错误，
 * 重试 2 次（共 3 次尝试，退避 300/700ms）后仍失败才记为 failed；永久失败
 * （库不存在等）三次同错，行为不变）。
 */
export async function dumpOneDatabase(sourceUrl, databaseName, runId, fileName) {
  let lastEntry = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastEntry = await dumpOneDatabaseOnce(sourceUrl, databaseName, runId, fileName);
    if (lastEntry.status === 'ok') return lastEntry;
    if (attempt < 2) {
      process.stdout.write(`[retry] ${databaseName}: dump failed（${lastEntry.error}），${attempt + 1}/2 次重试\n`);
      await sleepBackoff(attempt === 0 ? 300 : 700);
    }
  }
  return lastEntry;
}

async function main() {
  const { root, parallel, force } = parseArgs(process.argv.slice(2));
  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  const dailyDir = resolve(root, 'daily');
  await mkdir(dailyDir, { recursive: true, mode: 0o700 });
  await hardenBackupPermissions(root);

  const storage = createLocalDirStorage(root);
  const databases = enumerateBackupDatabases(sourceUrl, sourceDatabaseName);
  const startedAt = new Date().toISOString();
  process.stdout.write(`backup run ${runId}: ${databases.length} databases → ${dailyDir}\n`);

  const entries = [];
  let index = 0;
  for (const databaseName of databases) {
    index += 1;
    const fileName = buildDumpFileName(databaseName, new Date());
    const key = `daily/${fileName}`;
    const absolute = resolve(dailyDir, fileName);

    // 同 runId 重跑前清理（--force 显式覆盖语义：先删旧 dump 再备份）
    if (force) {
      const existing = await storage.list('daily/');
      for (const item of existing) {
        if (item.endsWith(`/${fileName}`)) await storage.delete(item).catch(() => {});
      }
    }

    const entry = await dumpOneDatabase(sourceUrl, databaseName, runId, absolute);
    // 清单记录裸文件名（与 key 相对路径分离，恢复时经 BACKUP_ROOT 解析）
    entries.push({ ...entry, file: entry.file ? fileName : null });
    process.stdout.write(
      `[${index}/${databases.length}] ${databaseName}: ${entry.status}${entry.error ? ` — ${entry.error}` : ''}\n`,
    );
  }

  const finishedAt = new Date().toISOString();
  // P8 t8 缺口1修复：MANIFEST 追加 media 段（.data/media/ 文件清单 path+sha256；缺失 → 空段不失败）
  const media = await collectMediaManifest(resolveMediaRoot());
  const manifest = {
    runId,
    startedAt,
    finishedAt,
    databases: entries,
    media: {
      exists: media.exists,
      retention: '7d daily / 12m monthly（媒体备份副本；原文件为 .data 活数据）',
      fileCount: media.files.length,
      files: media.files,
    },
    summary: {
      total: entries.length,
      ok: entries.filter((e) => e.status === 'ok').length,
      failed: entries.filter((e) => e.status === 'failed').length,
    },
  };
  const manifestName = `MANIFEST-${runId}.json`;
  const manifestPath = resolve(dailyDir, manifestName);
  await storage.put(`daily/${manifestName}`, Buffer.from(JSON.stringify(manifest, null, 2)));
  await chmod(manifestPath, 0o600);
  process.stdout.write(JSON.stringify({ tool: 'db-backup', ...manifest.summary, runId }) + '\n');

  // 轮转：所有备份产物按可信 UTC 年龄最多保留 30 天；未知格式会进入
  // blocked 清单而不会被删除。归档和清理均不读取备份正文以外的额外资料。
  const retention = await applyRetention(storage, { now: new Date(), maxAgeDays: 30, dryRun: false });
  await hardenBackupPermissions(root);
  if (retention.deletedDaily.length > 0) {
    process.stdout.write(`retention: deleted daily ${retention.deletedDaily.length}\n`);
  }
  if (retention.deletedMonthly.length > 0) {
    process.stdout.write(`retention: deleted monthly ${retention.deletedMonthly.length}\n`);
  }
  if (retention.deletedDeactivated?.length > 0) {
    process.stdout.write(`retention: deleted deactivated ${retention.deletedDeactivated.length}\n`);
  }

  if (manifest.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
