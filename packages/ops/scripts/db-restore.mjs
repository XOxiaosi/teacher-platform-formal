#!/usr/bin/env node
/**
 * db-restore：备份恢复（P7 B3，t12 设计 §4）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run db-restore -- --database <dbName> --from <dump 文件或清单项> [--target <恢复专用库名>] [--cleanup-on-failure]
 *
 * 分支：
 * 1. 演练分支（推荐）：--target teacher_db_*_restore_* / teacher_platform_restore_*
 *    → CREATE DATABASE <target> → pg_restore → 行数冒烟 → 结束（成功或失败均默认保留供检查/取证；
 *      仅显式 --cleanup-on-failure 才在失败时清理）。
 * 2. 真实覆盖分支（生产事故）：无 --target + --force 显式确认 → 先 dump 当前库留证
 *    → DROP → CREATE 重建 → pg_restore → 冒烟。
 *
 * 安全：--database 过教师库/共享库白名单；--from 路径必须在 BACKUP_ROOT 内
 * （normalize + 前缀断言，防 .. 穿越）；--target 必须过 assertSafeRestoreDatabaseName；
 * 覆盖分支必须 --force 且先留证；本地 host 红线。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeBaseUrl,
  assertSafeRestoreDatabaseName,
  assertSafeTeacherDatabaseName,
  SHARED_DB_NAME,
} from '../lib/db-safety.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  psqlEnvironment,
  psqlMaintenance,
  psqlQuery,
  quoteIdentifier,
  quoteLiteral,
  run,
  withDatabase,
  withPostgresBinPath,
} from '../lib/pg-utils.mjs';
import { buildDumpFileName } from './db-backup.mjs';

const DEFAULT_BACKUP_ROOT = process.env.BACKUP_ROOT
  ?? (process.platform === 'win32'
    ? `${process.env.TEMP || 'C:/Windows/Temp'}/teacher-platform-backups`
    : '/var/backups/teacher-platform');

export function parseArgs(argv) {
  const args = {
    database: undefined,
    from: undefined,
    target: undefined,
    force: false,
    cleanupOnFailure: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--database') args.database = argv[++i];
    else if (arg === '--from') args.from = argv[++i];
    else if (arg === '--target') args.target = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--cleanup-on-failure') args.cleanupOnFailure = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!args.database || !args.from) {
    throw new Error('用法: db-restore --database <dbName> --from <dump 文件或清单项> [--target <restore_xxx>] [--cleanup-on-failure] [--force]');
  }
  if (args.cleanupOnFailure && !args.target) {
    throw new Error('SAFETY_BLOCK: --cleanup-on-failure 仅可与 drill --target 一起使用');
  }
  return args;
}

/**
 * 解析 --from：可为 MANIFEST 里的裸文件名（在 daily/ 下）、daily/ 下相对路径或
 * BACKUP_ROOT 内相对路径。返回绝对路径 + 裸文件名。
 */
export function resolveDumpSource(root, from) {
  const rootResolved = resolve(root);
  const normalized = normalize(from);
  const candidatePaths = [normalized];
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    // 裸文件名 → 先尝试 daily/ 下（备份产物落点），再尝试 root 下
    candidatePaths.push(`daily/${normalized}`);
  } else if (!normalized.startsWith('daily')) {
    candidatePaths.push(`daily/${normalized}`);
  }

  for (const candidateRaw of candidatePaths) {
    const candidate = resolve(rootResolved, candidateRaw);
    if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${sep}`)) {
      throw new Error('SAFETY_BLOCK: --from 路径必须在 BACKUP_ROOT 内');
    }
    if (candidate.split(sep).includes('..')) {
      throw new Error('SAFETY_BLOCK: --from 路径禁止 .. 穿越');
    }
    if (existsSync(candidate)) {
      return { absolute: candidate, fileName: candidate.split(sep).pop() };
    }
  }
  throw new Error(`SAFETY_BLOCK: dump 文件不存在: ${from}`);
}

/** 在 MANIFEST（daily/MANIFEST-*.json）中查找 --database 对应的 sha256。 */
export function lookupManifestSha(root, databaseName, fileName) {
  const dailyDir = resolve(root, 'daily');
  if (!existsSync(dailyDir)) return undefined;
  const manifests = readdirManifests(dailyDir);
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.databases?.find((item) => item.name === databaseName && item.file === fileName);
    if (entry?.sha256) return entry.sha256;
  }
  return undefined;
}

function readdirManifests(dailyDir) {
  return readdirSync(dailyDir)
    .filter((name) => /^MANIFEST-\d{8}T\d{6}\.json$/.test(name) || /^MANIFEST-\d{14}\.json$/.test(name))
    .map((name) => resolve(dailyDir, name));
}

/** sha256 校验文件；不匹配抛错。 */
export function assertFileSha256(absolute, expectedSha) {
  if (!expectedSha) {
    throw new Error('SAFETY_BLOCK: dump 不属于任何受信 MANIFEST，禁止恢复');
  }
  const content = readFileSync(absolute);
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== expectedSha) {
    throw new Error(`SAFETY_BLOCK: sha256 不匹配（清单 ${expectedSha} vs 实际 ${actual}）`);
  }
}

/** 行数冒烟：关键表 students/payments count 一致（对比源库与恢复库）。 */
export function smokeRows(sourceUrl, sourceDatabaseName, restoredUrl, restoredName) {
  const tables = ['Student', 'Payment'];
  const report = [];
  for (const table of tables) {
    const sourceCount = psqlQuery(
      sourceUrl, sourceDatabaseName,
      `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`,
    )[0] ?? '0';
    const restoredCount = psqlQuery(
      restoredUrl, restoredName,
      `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`,
    )[0] ?? '0';
    report.push({ table, source: sourceCount, restored: restoredCount, match: sourceCount === restoredCount });
  }
  const allMatch = report.every((r) => r.match);
  return { report, allMatch };
}

function databaseExists(maintenanceUrl, databaseName) {
  const rows = psqlMaintenance(
    maintenanceUrl,
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
  );
  return rows.length > 0;
}

function terminateAndDrop(maintenanceUrl, databaseName) {
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(databaseName)} AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
}

/** drill 失败时默认保留目标库；只有显式 opt-in 才清理。 */
export function cleanupFailedDrill({
  cleanupOnFailure,
  maintenanceUrl,
  target,
  terminateAndDropImpl = terminateAndDrop,
}) {
  if (!cleanupOnFailure) return { cleaned: false, retained: true };
  terminateAndDropImpl(maintenanceUrl, target);
  return { cleaned: true, retained: false };
}

function createDatabase(maintenanceUrl, databaseName) {
  psqlMaintenance(maintenanceUrl, `CREATE DATABASE ${quoteIdentifier(databaseName)}`);
}

function pgRestore(dumpPath, restoredUrl, restoredName) {
  const env = withPostgresBinPath(psqlEnvironment(restoredUrl, restoredName));
  // pg_restore 不接受 URL 查询参数（如 ?schema=public），去掉 query/hash 再传。
  const cleanUrl = new URL(restoredUrl.toString());
  cleanUrl.search = '';
  cleanUrl.hash = '';
  const result = run('pg_restore', ['-Fc', '-d', cleanUrl.toString(), dumpPath], { env });
  if (result.error || result.status !== 0) {
    throw new Error(`pg_restore failed: ${result.error?.message ?? result.stderr?.trim() ?? 'unknown'}`);
  }
}

async function main() {
  const { database, from, target, force, cleanupOnFailure } = parseArgs(process.argv.slice(2));
  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');
  const root = resolve(DEFAULT_BACKUP_ROOT);

  // 目标库名安全校验（教师库或共享库）
  if (database === SHARED_DB_NAME) {
    // 共享库允许
  } else {
    assertSafeTeacherDatabaseName(database, sourceDatabaseName);
  }

  const { absolute: dumpPath, fileName } = resolveDumpSource(root, from);
  const expectedSha = lookupManifestSha(root, database, fileName);
  assertFileSha256(dumpPath, expectedSha);

  const restoredUrl = target ? withDatabase(sourceUrl, target) : withDatabase(sourceUrl, database);

  if (target) {
    // 演练分支：目标必须是恢复专用库形态
    assertSafeRestoreDatabaseName(target);
    if (databaseExists(maintenanceUrl, target)) {
      throw new Error(`SAFETY_BLOCK: 演练目标库已存在: ${target}（先清理再演练）`);
    }
    process.stdout.write(`drill restore: ${database} → ${target}\n`);
    createDatabase(maintenanceUrl, target);
    try {
      pgRestore(dumpPath, restoredUrl, target);
      const { report, allMatch } = smokeRows(sourceUrl, database, restoredUrl, target);
      for (const row of report) {
        process.stdout.write(`row check ${row.table}: source=${row.source} restored=${row.restored} ${row.match ? 'MATCH' : 'MISMATCH'}\n`);
      }
      if (!allMatch) process.exitCode = 1;
      process.stdout.write(JSON.stringify({ tool: 'db-restore', mode: 'drill', database, target, rowMatch: allMatch }) + '\n');
    } catch (error) {
      const cleanup = cleanupFailedDrill({ cleanupOnFailure, maintenanceUrl, target });
      if (cleanup.cleaned) {
        process.stderr.write(`drill restore failed; opt-in cleanup removed target database: ${target}\n`);
      } else {
        process.stderr.write(`drill restore failed; target database retained for inspection: ${target}\n`);
      }
      throw error;
    }
    return;
  }

  // 真实覆盖分支：必须 --force
  if (!force) {
    throw new Error('SAFETY_BLOCK: 真实覆盖源库必须 --force 显式确认');
  }
  process.stdout.write(`force restore: ${database} ← ${fileName}\n`);
  // 先 dump 当前库留证（pg_dump 不接受 URL 查询参数，如 ?schema=public——与 db-backup 同处理）
  const evidencePath = resolve(DEFAULT_BACKUP_ROOT, 'daily', buildDumpFileName(`${database}_pre_restore`, new Date()));
  const env = withPostgresBinPath(psqlEnvironment(sourceUrl, database));
  const evidenceUrl = new URL(sourceUrl.toString());
  evidenceUrl.search = '';
  evidenceUrl.hash = '';
  const evidence = run('pg_dump', ['-Fc', '-Z', '9', '-f', evidencePath, '-d', evidenceUrl.toString()], { env });
  if (evidence.error || evidence.status !== 0) {
    throw new Error(`留证 dump 失败，中止覆盖: ${evidence.error?.message ?? evidence.stderr}`);
  }
  process.stdout.write(`evidence dump: ${evidencePath}\n`);

  terminateAndDrop(maintenanceUrl, database);
  createDatabase(maintenanceUrl, database);
  try {
    pgRestore(dumpPath, restoredUrl, database);
    const { report, allMatch } = smokeRows(sourceUrl, database, restoredUrl, database);
    for (const row of report) {
      process.stdout.write(`row check ${row.table}: source=${row.source} restored=${row.restored} ${row.match ? 'MATCH' : 'MISMATCH'}\n`);
    }
    process.stdout.write(JSON.stringify({ tool: 'db-restore', mode: 'force', database, rowMatch: allMatch }) + '\n');
  } catch (error) {
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
