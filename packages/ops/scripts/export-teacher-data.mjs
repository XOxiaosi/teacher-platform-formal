#!/usr/bin/env node
/**
 * 按教师导出全部数据（P7-P1 · t42，t37 设计 §2 隐私导出权）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run export-teacher-data -- --teacher-id <id> [--out <dir>] [--zip]
 *   npm -w @teacher-platform/ops run export-teacher-data -- --email <email> [--out <dir>] [--zip]
 *   npm -w @teacher-platform/ops run export-teacher-data -- --database-name <teacher_db_xxx> [--out <dir>] [--zip]
 *
 * --zip：P14 t5 媒体导出 zip 单包（阶段三自助下载通道）。目录导出完成后，把
 *   manifest.json / account.json / tables/*.jsonl / media/* 打包为 <out>.zip
 *   （零依赖 store-only ZIP，lib/zip-writer.mjs：CRC32 手写、流式写大媒体文件、
 *   UTF-8 文件名）。目录产物保留（zip 为交付包，目录供逐文件核对 sha256）。
 *
 * 流程：
 * 1. 共享库 TeacherRegistry 查该教师（安全校验 + 只取公开字段，SQL 层就不 select passwordHash）；
 * 2. 定位教师独立库（databaseName，assertSafeTeacherDatabaseName 校验）；
 * 3. 逐表导出 27 个业务表为 JSONL——21 个教师库表（WHERE "teacherId" = <id>，row_to_json 保真，含 JSONB 字段）
 *    + 6 个共享库教师维度表（ChannelIdentity/ChannelMessage/ChannelConversation/ProviderConfig/
 *    ProviderUsage/UserRequirement，同样按 teacherId 过滤，防跨教师泄露）；
 * 4. 媒体文件本体导出（P13 t2）：按 MediaAsset 行 originalPath（存储 key）经 StorageBackend 读
 *    原始文件 → 副本写入 <out>/media/...（镜像活存储布局）；manifest.media 条目 {path,sha256,sizeBytes}；
 *    源文件只读不删（与备份区分：备份是全量+保留策略，导出是按教师一次性的隐私交付）；
 * 5. 写 account.json + tables/<table>.jsonl + manifest.json（每卷 sha256 + 行数 + 来源库 + media 段）。
 *
 * 输出目录：
 *   <out>/account.json          # TeacherRegistry 公开字段（不含 passwordHash）
 *   <out>/tables/<table>.jsonl  # 每表一行一 JSON 对象
 *   <out>/media/<...>           # 媒体文件本体副本（按 originalPath 镜像；无媒体教师不建目录）
 *   <out>/manifest.json         # 导出元数据（教师/时间/分卷清单/行数/sha256/来源库 + media 段）
 *
 * 安全：
 * - 只读导出：仅 SELECT + storage.get（只读媒体），禁写/删库、禁删源文件；
 * - 导出文件 0600 / 目录 0700（Linux 完整生效；Windows NTFS ACL 部分生效）；
 * - 教师不存在 → 明确错误；库名/URL 过 assertSafe* 校验；本地 host 红线；
 * - 不导出 passwordHash / tokenHash（SessionStore 不在导出范围）；ProviderConfig.apiKeyEnc 仅密文；
 * - 媒体 key 只取 MediaAsset.originalPath（DB 归属该教师 → 防路径枚举跨教师泄露），storage.get
 *   内置 assertStorageKey（防穿越），副本目标再断言在 outDir 内（纵深防御）。
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeBaseUrl,
  assertSafeTeacherDatabaseName,
  SHARED_DB_NAME,
} from '../lib/db-safety.mjs';
import { createStorageBackendFromEnv } from '../lib/storage-backend.mjs';
import { createStoreOnlyZip } from '../lib/zip-writer.mjs';
import {
  databaseNameFromUrl,
  loadDatabaseUrl,
  projectRoot,
  psqlEnvironment,
  psqlQuery,
  quoteIdentifier,
  quoteLiteral,
  run,
  withDatabase,
  withPostgresBinPath,
} from '../lib/pg-utils.mjs';

const SHARED_DB = SHARED_DB_NAME;

/**
 * 21 个教师库业务表（t37 §2.3 基线 20 个 + P12 补漏 MediaAsset 媒体证据链元数据；
 * 不动态扫表，确定性；全部含 teacherId 列，MediaAsset 走教师库 getClient 路由）。
 * 注：媒体文件本体存 .data 存储（originalPath 相对路径）；DB 行导出元数据，文件本体副本由
 * P13 t2 媒体段导出（exportTeacherMedia，StorageBackend 读取，manifest.media）。
 */
export const TEACHER_DB_TABLES = [
  'Student', 'Schedule', 'Lesson', 'AINote', 'Conversation', 'ConversationTurn',
  'AgentExecution', 'PendingAction', 'Payment', 'DailyReview', 'PushRecord', 'ChangeLog',
  'Memo', 'ParentFeedback', 'StudentSourceRecord', 'StudentRecord', 'AssessmentDetail',
  'CommunicationDetail', 'FeedbackContextSnapshot', 'FeedbackEvidence',
  'MediaAsset',
];

/**
 * 6 个共享库教师维度表（P7 渠道线 ProviderConfig/ProviderUsage/UserRequirement +
 * P8 微信线 ChannelIdentity/ChannelMessage/ChannelConversation——schema 注释均为共享库表，
 * 服务用装配期共享 prisma，数据不在教师库）。全部含 teacherId 列，导出必须按 teacherId 过滤，
 * 防跨教师泄露（ChannelMessage.teacherId 可空=未绑定挂起，过滤后自然排除）。
 * 注：ProviderConfig.apiKeyEnc 为 AES-256-GCM 密文（只写不回明文），导出仅含密文。
 */
export const SHARED_DB_TABLES = [
  'ChannelIdentity', 'ChannelMessage', 'ChannelConversation',
  'ProviderConfig', 'ProviderUsage', 'UserRequirement',
];

/** 导出清单（manifest tables 顺序：教师库表 → 共享库表；共 27 表）。 */
export const BUSINESS_TABLES = [...TEACHER_DB_TABLES, ...SHARED_DB_TABLES];

const SHARED_TABLE_SET = new Set(SHARED_DB_TABLES);

export function parseArgs(argv) {
  const args = { teacherId: undefined, email: undefined, databaseName: undefined, out: undefined, zip: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--teacher-id') args.teacherId = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--database-name') args.databaseName = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--zip') args.zip = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  const identityCount = [args.teacherId, args.email, args.databaseName].filter((v) => v).length;
  if (identityCount !== 1) {
    throw new Error('用法: export-teacher-data --teacher-id <id> | --email <email> | --database-name <teacher_db_xxx> [--out <dir>] [--zip]');
  }
  return args;
}

/**
 * 递归收集导出目录全部文件 → zip entries（zip 内路径与目录结构对齐：
 * manifest.json / account.json / tables/*.jsonl / media/*；仅文件，跳过目录）。
 * @param {string} outDir 导出根目录（已含全部产物）
 * @returns {Promise<Array<{name:string, sourcePath:string}>>} zip 条目（相对正斜杠名）
 */
export async function collectExportZipEntries(outDir) {
  const entries = [];
  async function walk(dir, prefix) {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = resolve(dir, dirent.name);
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        await walk(full, rel);
      } else if (dirent.isFile()) {
        entries.push({ name: rel, sourcePath: full });
      }
    }
  }
  await walk(outDir, '');
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 从共享库读 TeacherRegistry 公开字段（SQL 层不 select passwordHash，纵深防御）。
 * 返回 { id, email, displayName, status, databaseName, createdAtTs, updatedAtTs } 或 null。
 */
export function readTeacherAccount(sourceUrl, { teacherId, email }) {
  const where = teacherId
    ? `"id" = ${quoteLiteral(teacherId)}`
    : `"email" = ${quoteLiteral(email)}`;
  const sql = `SELECT row_to_json(t) FROM (SELECT "id","email","displayName","status","databaseName","createdAtTs","updatedAtTs" FROM "TeacherRegistry" WHERE ${where}) t`;
  const rows = psqlQuery(sourceUrl, SHARED_DB, sql);
  if (rows.length === 0) return null;
  return JSON.parse(rows[0]);
}

/** 单表导出：SELECT 全部行（有 teacherId 时按列过滤，无则整库——库归属该教师）→ JSONL 行数组。 */
export function exportTable(sourceUrl, databaseName, table, teacherId) {
  const env = withPostgresBinPath({
    ...psqlEnvironment(sourceUrl, databaseName),
    PGCLIENTENCODING: 'UTF8', // 防 Windows 控制台 GBK 重编码损坏 JSON
  });
  const where = teacherId ? ` WHERE "teacherId" = ${quoteLiteral(teacherId)}` : '';
  const sql = `SELECT row_to_json(t) FROM (SELECT * FROM ${quoteIdentifier(table)}${where}) t`;
  const result = run('psql', ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env });
  if (result.error || result.status !== 0) {
    throw new Error(`导出表 ${table} 失败: ${result.error?.message ?? result.stderr?.trim() ?? 'unknown'}`);
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * 共享库反查：由教师库名定位归属教师 id（直连 --database-name 模式的共享库表过滤用；
 * 查不到返回 null——绝不无过滤导出共享库表，防跨教师泄露）。
 */
export function lookupTeacherIdByDatabaseName(sourceUrl, databaseName) {
  const rows = psqlQuery(
    sourceUrl,
    SHARED_DB,
    `SELECT "id" FROM "TeacherRegistry" WHERE "databaseName" = ${quoteLiteral(databaseName)} LIMIT 1`,
  );
  return rows.length > 0 ? rows[0] : null;
}

/** 导出目录权限：文件 0600 / 目录 0700（best effort）。 */
export async function chmodPrivate(path, isDir = false) {
  try {
    await chmod(path, isDir ? 0o700 : 0o600);
  } catch {
    // Windows NTFS ACL 下部分生效；Linux 完整生效
  }
}

/** 媒体存储根（MEDIA_STORAGE_ROOT env 优先；缺省 monorepo 根 .data——与后端 createStorage 同根约定）。 */
export function resolveMediaRoot() {
  return process.env.MEDIA_STORAGE_ROOT
    ? resolve(process.env.MEDIA_STORAGE_ROOT)
    : resolve(projectRoot, '.data');
}

/**
 * 从 MediaAsset 导出行提取媒体存储 key 清单（originalPath 去重、非空）。
 * 只取 DB 归属该教师的 originalPath——不做目录枚举，防跨教师泄露（孤儿文件不入导出）。
 * @param {string[]} lines MediaAsset JSONL 行（导出查询结果）
 * @returns {string[]} 去重后的存储 key（如 'media/<teacherId>/<assetId>/original'）
 */
export function exportMediaKeysFromRows(lines) {
  const keys = new Set();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (typeof row?.originalPath === 'string' && row.originalPath.trim().length > 0) {
        keys.add(row.originalPath);
      }
    } catch {
      // 单行损坏不阻断（元数据行已落 JSONL，损坏由 manifest sha256 兜底可查）
    }
  }
  return [...keys].sort();
}

/**
 * 导出媒体文件本体（P13 t2）：经 StorageBackend 读原始文件 → 副本写入 <out>/media/<key>（镜像活存储布局）。
 * 只读源（storage.get），绝不删除源文件。缺失文件（ENOENT/NoSuchKey）记 {path,status:'missing'} 不阻断；
 * 其他错误（网络/权限）抛出使导出失败（媒体缺失不可静默）。
 * @param {{get(key:string):Promise<Buffer>}} storage StorageBackend（local 从 .data 读、s3 从桶读）
 * @param {string[]} mediaKeys 存储 key 清单（exportMediaKeysFromRows 输出）
 * @param {string} outDir 导出根目录
 * @returns {Promise<Array<{path:string,sha256?:string,sizeBytes?:number,status?:string}>>} manifest.media 条目
 */
export async function exportTeacherMedia(storage, mediaKeys, outDir) {
  const entries = [];
  for (const key of mediaKeys) {
    let content;
    try {
      content = await storage.get(key);
    } catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT' || code === 'NoSuchKey') {
        entries.push({ path: key, status: 'missing' });
        process.stderr.write(`[media] 缺失（已记录，不阻断）: ${key}\n`);
        continue;
      }
      throw error;
    }
    // 副本目标 = <outDir>/<key>（key 为 storage 相对路径，storage.get 已过 assertStorageKey）
    const target = resolve(outDir, key);
    const rel = relative(outDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`SAFETY_BLOCK: 媒体导出路径逃逸: ${key}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmodPrivate(target);
    entries.push({
      path: key,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
    });
    process.stdout.write(`[media] ${key} (${content.length} bytes)\n`);
  }
  return entries;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);

  // 1. 定位教师与库
  let account;
  let databaseName;
  let exportTeacherId;
  if (args.databaseName) {
    // 直连模式：库本身归属该教师（assertSafeTeacherDatabaseName 保证 teacher_db_* 前缀），
    // 整库导出（无 teacherId 过滤，避免误过滤掉库内全部数据）。
    databaseName = args.databaseName;
    account = { databaseName, exportedByDatabaseName: true };
  } else {
    account = readTeacherAccount(sourceUrl, { teacherId: args.teacherId, email: args.email });
    if (!account) {
      const identity = args.teacherId ? `id=${args.teacherId}` : `email=${args.email}`;
      throw new Error(`教师不存在（${identity}）——请确认 TeacherRegistry 记录`);
    }
    databaseName = account.databaseName;
    exportTeacherId = account.id; // 用 TeacherRegistry 的真实 id 过滤（防共享库混租户）
  }

  // 目标库校验：独立教师库过 assertSafeTeacherDatabaseName；共享库（阶段一过渡态，
  // 未建独立库的教师 databaseName 默认为 teacher_platform）允许但必须有 teacherId 过滤。
  if (databaseName === SHARED_DB) {
    if (!exportTeacherId) {
      throw new Error('SAFETY_BLOCK: 直连共享库模式必须提供 --teacher-id/--email 以按教师过滤');
    }
  } else {
    assertSafeTeacherDatabaseName(databaseName, sourceDatabaseName);
  }

  // 2. 准备输出目录
  const outDir = resolve(args.out ?? `export-${args.teacherId ?? args.email ?? databaseName}`);
  const tablesDir = resolve(outDir, 'tables');
  await mkdir(tablesDir, { recursive: true });
  await chmodPrivate(outDir, true);
  await chmodPrivate(tablesDir, true);

  const exportedAt = new Date().toISOString();
  const manifest = {
    version: '1.0',
    exportedAt,
    teacherId: args.teacherId ?? null,
    email: args.email ?? null,
    databaseName,
    note: '按教师导出全部业务数据（含媒体元数据/渠道/用量，27 表 + 媒体文件本体）；不含 passwordHash / tokenHash',
    tables: [],
  };

  // 直连模式（--database-name）：共享库表需要归属教师 id——TeacherRegistry 反查；
  // 查不到 → 共享库表空导出（不无过滤查询，防跨教师泄露），教师库表仍整库导出（既有语义）。
  let directOwnerTeacherId = exportTeacherId;
  if (!directOwnerTeacherId && args.databaseName) {
    directOwnerTeacherId = lookupTeacherIdByDatabaseName(sourceUrl, databaseName);
  }

  // 3. 逐表导出（只读 SELECT；表清单固定，含 JSONB 保真；教师库表与共享库表分库查询）
  let mediaKeys = []; // P13：MediaAsset 行 originalPath（媒体文件本体存储 key 清单）
  for (const table of BUSINESS_TABLES) {
    const isShared = SHARED_TABLE_SET.has(table);
    const tableDatabase = isShared ? SHARED_DB : databaseName;
    const filterTeacherId = exportTeacherId ?? (isShared ? directOwnerTeacherId : undefined);
    let lines;
    if (isShared && !filterTeacherId) {
      // 直连模式无法归属教师 → 空导出（跳过查询，不泄露他教师数据）
      lines = [];
      process.stderr.write(`[${table}] 跳过共享库表（直连模式无法归属教师：teacher_platform 无 databaseName=${databaseName} 记录）\n`);
    } else {
      lines = exportTable(sourceUrl, tableDatabase, table, filterTeacherId);
    }
    const fileName = `${table.toLowerCase()}.jsonl`;
    const filePath = resolve(tablesDir, fileName);
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await writeFile(filePath, content, 'utf8');
    await chmodPrivate(filePath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    manifest.tables.push({
      table,
      source: isShared ? 'shared_db' : 'teacher_db',
      file: `tables/${fileName}`,
      rows: lines.length,
      sha256,
    });
    process.stdout.write(`[${table}] ${lines.length} rows\n`);
    if (table === 'MediaAsset') {
      mediaKeys = exportMediaKeysFromRows(lines);
    }
  }

  // 4. 媒体文件本体导出（P13 t2：隐私导出权完整性——教师「我的全部数据」含自传媒体；
  //    只读源（storage.get），副本写 outDir；无媒体教师 → mediaKeys 空 → media 段 [] 不建目录）
  const mediaEntries = mediaKeys.length > 0
    ? await exportTeacherMedia(createStorageBackendFromEnv(process.env, resolveMediaRoot()), mediaKeys, outDir)
    : [];
  manifest.media = mediaEntries;

  // 5. account.json + manifest.json
  const accountPath = resolve(outDir, 'account.json');
  await writeFile(accountPath, `${JSON.stringify(account, null, 2)}\n`, 'utf8');
  await chmodPrivate(accountPath);
  const manifestPath = resolve(outDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await chmodPrivate(manifestPath);

  const totalRows = manifest.tables.reduce((sum, item) => sum + item.rows, 0);
  const mediaBytes = mediaEntries.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  // 6. --zip：目录产物打包单文件 <out>.zip（P14 t5；零依赖 store-only ZIP + CRC32 + UTF-8 文件名）
  let zipPath = null;
  let zipBytes = 0;
  if (args.zip) {
    const entries = await collectExportZipEntries(outDir);
    if (entries.length === 0) {
      throw new Error('SAFETY_BLOCK: zip 打包失败——导出目录无文件（不应发生：account/manifest 已写）');
    }
    zipPath = `${outDir}.zip`;
    const zipResult = await createStoreOnlyZip({ outputPath: zipPath, entries });
    zipBytes = zipResult.sizeBytes;
    await chmodPrivate(zipPath);
    process.stdout.write(`[zip] ${zipPath} (${zipBytes} bytes, ${zipResult.entryCount} entries)\n`);
  }

  process.stdout.write(JSON.stringify({
    tool: 'export-teacher-data',
    teacherId: args.teacherId ?? null,
    email: args.email ?? null,
    databaseName,
    out: outDir,
    zip: zipPath,
    zipBytes,
    tables: manifest.tables.length,
    totalRows,
    mediaFiles: mediaEntries.length,
    mediaBytes,
    accountSha256: createHash('sha256').update(JSON.stringify(account)).digest('hex'),
    exportedAt,
  }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
