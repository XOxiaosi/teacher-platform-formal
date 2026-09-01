#!/usr/bin/env node
/**
 * 账户注销脚本（P7-P1 · t43，t37 设计 §3 隐私删除权；P8 t8 扩展 --cleanup-media）。
 *
 * 用法：
 *   npm -w @teacher-platform/ops run deactivate-teacher -- --teacher-id <id> [--dry-run] [--confirm] [--cleanup-media]
 *
 * 流程（t37 §3，事务边界：先 DROP 独立库、后删 TeacherRegistry，防「可登录无数据」态）：
 * 1. 前置检查（只读）：active 会话数、pending/executing PendingAction、running AgentExecution；
 *    存在未决 PendingAction / running 执行 → 阻止并明确提示（须先处理）；
 * 2. 备份留证：dump 该教师独立库（若非共享库）+ 共享库到 BACKUP_ROOT/deactivated/（复用 db-backup 双校验）；
 * 3. [--cleanup-media] 媒体清理（P8 t8，缺口2修复）：先备份留证 .data/media/<teacherId>/ 打包为
 *    media-<teacherId>-<ts>.tar（sha256）到 deactivated/ 并登记 registry.log，成功后才物理删除
 *    .data/media/<teacherId>/——与 DROP DATABASE 同一 --confirm 门禁；
 * 4. DROP 教师独立库（assertSafeTeacherDatabaseName + pg_terminate_backend；共享库/开发库 teacher_platform 禁删）；
 * 5. 删除 TeacherRegistry 记录 + 其 SessionStore（无 onDelete 级联，先删会话再删记录）；
 * 6. 注销登记簿：追加 BACKUP_ROOT/deactivated/registry.log（谁/何时/哪个教师/备份引用）——t37 §4 备份残留合规缓解。
 *
 * 安全：
 * - --confirm 是硬性二次确认（缺省拒绝执行）；
 * - --dry-run 只报告不执行；
 * - 禁删共享库 teacher_platform（开发库红线）；教师不存在 → 明确错误（幂等）；
 * - --cleanup-media 必须先备份留证成功才物理删除媒体目录（与备份留证纪律一致）。
 */

import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
  quoteIdentifier,
  quoteLiteral,
  run,
  withDatabase,
  withPostgresBinPath,
} from '../lib/pg-utils.mjs';
import { dumpOneDatabase, buildDumpFileName } from './db-backup.mjs';

const SHARED_DB = SHARED_DB_NAME;
/** 注销留证根目录：调用时求值（BACKUP_ROOT env 可被测试注入）。 */
export function deactivatedRoot() {
  return process.env.BACKUP_ROOT
    ? resolve(process.env.BACKUP_ROOT, 'deactivated')
    : (process.platform === 'win32'
      ? `${process.env.TEMP || 'C:/Windows/Temp'}/teacher-platform-backups/deactivated`
      : '/var/backups/teacher-platform/deactivated');
}

/** 媒体存储根（MEDIA_STORAGE_ROOT env 优先；缺省 monorepo 根 .data——与后端 createStorage 同根约定）。 */
export function resolveMediaRoot() {
  return process.env.MEDIA_STORAGE_ROOT
    ? resolve(process.env.MEDIA_STORAGE_ROOT)
    : resolve(projectRoot, '.data');
}

/** teacherId 路径安全校验：仅字母数字下划线连字符（防目录穿越）。 */
export function assertSafeMediaTeacherId(teacherId) {
  if (!/^[A-Za-z0-9_-]+$/.test(teacherId)) {
    throw new Error(`SAFETY_BLOCK: teacherId 含非法路径字符: ${teacherId}`);
  }
  return teacherId;
}

/**
 * 媒体清理（P8 t8 缺口2修复）：先备份留证（tar + sha256 + registry.log），成功后才物理删除。
 * @param {string} mediaRoot 媒体存储根
 * @param {string} teacherId
 * @param {string} deactivatedRoot 留证目录
 * @returns {Promise<{skipped?: boolean, reason?: string, archived?: boolean, tarFile?: string|null, sha256?: string|null}>}
 */
export async function cleanupMediaEvidence(mediaRoot, teacherId, deactivatedRoot) {
  assertSafeMediaTeacherId(teacherId);
  const mediaDir = resolve(mediaRoot, 'media', teacherId);
  if (!existsSync(mediaDir)) {
    return { skipped: true, reason: 'no-media-dir', tarFile: null, sha256: null };
  }

  await mkdir(deactivatedRoot, { recursive: true });
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const tarFile = `media-${teacherId}-${stamp}.tar`;
  const tarAbsolute = resolve(deactivatedRoot, tarFile);

  // 打包（bsdtar/GNU tar 通用；-C 指定父目录，只打包 teacherId 子目录）
  const result = run('tar', ['-cf', tarAbsolute, '-C', resolve(mediaRoot, 'media'), teacherId], {});
  if (result.error || result.status !== 0) {
    throw new Error(`媒体留证打包失败: ${result.error?.message ?? result.stderr?.trim() ?? 'tar failed'}`);
  }

  // sha256 校验
  const fileStat = await stat(tarAbsolute);
  if (fileStat.size === 0) {
    throw new Error('媒体留证打包为空——拒绝删除（安全红线）');
  }
  const sha256 = await sha256File(tarAbsolute);

  // 登记簿（与 deactivate 同簿，action 区分）
  await appendRegistryLog(deactivatedRoot, {
    ts: now.toISOString(),
    operator: process.env.OPERATOR ?? 'ops-cli',
    teacherId,
    action: 'media-cleanup',
    mediaTar: tarFile,
    mediaSha256: sha256,
  });

  // 留证成功 → 物理删除
  await rm(mediaDir, { recursive: true, force: true });
  return { skipped: false, archived: true, tarFile, sha256 };
}

/** 流式 sha256（大文件不整读内存）。 */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export function parseArgs(argv) {
  const args = { teacherId: undefined, dryRun: false, confirm: false, cleanupMedia: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--teacher-id') args.teacherId = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--cleanup-media') args.cleanupMedia = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!args.teacherId) {
    throw new Error('用法: deactivate-teacher --teacher-id <id> [--dry-run] [--confirm] [--cleanup-media]');
  }
  return args;
}

/** 前置检查（只读）：返回 { activeSessions, pendingActions, runningExecutions }。 */
export function preflight(sourceUrl, databaseName, teacherId) {
  const activeSessions = Number(psqlQuery(
    sourceUrl,
    SHARED_DB,
    `SELECT COUNT(*) FROM "SessionStore" WHERE "teacherId" = ${quoteLiteral(teacherId)} AND "expiresAtTs" > now()`,
  )[0] ?? 0);

  // 独立库里的业务前置检查（共享库模式跳过——业务表在共享库但按教师过滤查询同样可行）
  let pendingActions = 0;
  let runningExecutions = 0;
  try {
    const env = withPostgresBinPath(psqlEnvironment(sourceUrl, databaseName));
    const pendingSql = `SELECT COUNT(*) FROM "PendingAction" WHERE "teacherId" = ${quoteLiteral(teacherId)} AND "status" IN ('pending','executing')`;
    const pending = psqlQuery(sourceUrl, databaseName, pendingSql);
    pendingActions = Number(pending[0] ?? 0);

    const runningSql = `SELECT COUNT(*) FROM "AgentExecution" WHERE "teacherId" = ${quoteLiteral(teacherId)} AND "status" = 'running'`;
    const running = psqlQuery(sourceUrl, databaseName, runningSql);
    runningExecutions = Number(running[0] ?? 0);
  } catch {
    // 库不存在（未建库/已删）：业务前置检查无意义，视为 0
  }

  return { activeSessions, pendingActions, runningExecutions };
}

/** 备份留证：dump 教师独立库（非共享库）+ 共享库 → BACKUP_ROOT/deactivated/。返回 { teacherDump, sharedDump }。 */
export async function backupEvidence(sourceUrl, databaseName, rootDir) {
  await mkdir(rootDir, { recursive: true });
  const now = new Date();
  const result = { teacherDump: null, sharedDump: null };

  if (databaseName !== SHARED_DB) {
    const fileName = buildDumpFileName(databaseName, now);
    const absolute = resolve(rootDir, fileName);
    const entry = await dumpOneDatabase(sourceUrl, databaseName, `deactivate-${now.toISOString()}`, absolute);
    if (entry.status !== 'ok') throw new Error(`备份留证失败（${databaseName}）: ${entry.error ?? 'unknown'}`);
    result.teacherDump = fileName;
  }

  const sharedFile = buildDumpFileName(SHARED_DB, now);
  const sharedAbsolute = resolve(rootDir, sharedFile);
  const sharedEntry = await dumpOneDatabase(sourceUrl, SHARED_DB, `deactivate-${now.toISOString()}`, sharedAbsolute);
  if (sharedEntry.status !== 'ok') throw new Error(`备份留证失败（${SHARED_DB}）: ${sharedEntry.error ?? 'unknown'}`);
  result.sharedDump = sharedFile;

  return result;
}

/** 注销登记簿：追加 JSON 行（t37 §4 备份残留合规缓解）。 */
export async function appendRegistryLog(rootDir, entry) {
  await mkdir(rootDir, { recursive: true });
  const logPath = resolve(rootDir, 'registry.log');
  await appendFile(logPath, `${JSON.stringify({ tool: 'deactivate-teacher', ...entry })}\n`, 'utf8');
  return logPath;
}

/** 删除独立教师库：terminate 连接后 DROP（共享库禁删；库名过 assertSafeTeacherDatabaseName）。 */
export function dropTeacherDatabase(maintenanceUrl, databaseName, sourceDatabaseName) {
  if (databaseName === SHARED_DB) {
    throw new Error('SAFETY_BLOCK: 禁止删除共享库/开发库 teacher_platform');
  }
  assertSafeTeacherDatabaseName(databaseName, sourceDatabaseName);
  psqlMaintenance(
    maintenanceUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(databaseName)} AND pid <> pg_backend_pid()`,
  );
  psqlMaintenance(maintenanceUrl, `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
}

/** 删除 TeacherRegistry 记录（先删 SessionStore，无级联）。 */
export function deleteTeacherRecord(sourceUrl, teacherId) {
  psqlQuery(
    sourceUrl,
    SHARED_DB,
    `DELETE FROM "SessionStore" WHERE "teacherId" = ${quoteLiteral(teacherId)}`,
  );
  const affected = Number(psqlQuery(
    sourceUrl,
    SHARED_DB,
    `DELETE FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(teacherId)} RETURNING 1`,
  ).length ?? 0);
  return affected > 0;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.confirm && !args.dryRun) {
    throw new Error('SAFETY_BLOCK: 注销是删除操作，必须显式 --confirm 二次确认（或 --dry-run 预演）');
  }

  const baseUrl = loadDatabaseUrl();
  const { url: sourceUrl } = assertSafeBaseUrl(baseUrl);
  const maintenanceUrl = withDatabase(sourceUrl, 'postgres');
  const rootDir = resolve(deactivatedRoot());

  // 读教师
  const accountRows = psqlQuery(
    sourceUrl,
    SHARED_DB,
    `SELECT row_to_json(t) FROM (SELECT "id","email","displayName","status","databaseName" FROM "TeacherRegistry" WHERE "id" = ${quoteLiteral(args.teacherId)}) t`,
  );
  if (accountRows.length === 0) {
    throw new Error(`教师不存在（id=${args.teacherId}）——幂等：无需注销`);
  }
  const account = JSON.parse(accountRows[0]);
  const databaseName = account.databaseName ?? SHARED_DB;

  // 1. 前置检查
  const pre = preflight(sourceUrl, databaseName, args.teacherId);
  process.stdout.write(`preflight: activeSessions=${pre.activeSessions} pendingActions=${pre.pendingActions} runningExecutions=${pre.runningExecutions}\n`);
  if (pre.pendingActions > 0 || pre.runningExecutions > 0) {
    throw new Error(`SAFETY_BLOCK: 存在未决 PendingAction(${pre.pendingActions}) 或 running AgentExecution(${pre.runningExecutions})——须先处理再注销`);
  }

  const actions = [
    `备份留证 → ${rootDir}/（教师库${databaseName !== SHARED_DB ? ' + ' + databaseName : ''} + 共享库）`,
    ...(args.cleanupMedia
      ? [`媒体留证+删除 → ${rootDir}/media-${args.teacherId}-<ts>.tar + .data/media/${args.teacherId}/（先留证后删）`]
      : []),
    databaseName !== SHARED_DB ? `DROP DATABASE ${databaseName}` : '（共享库模式：不删库，仅删注册记录）',
    `DELETE TeacherRegistry ${args.teacherId}（含 ${pre.activeSessions} 个会话）`,
    `追加注销登记簿 ${rootDir}/registry.log`,
  ];
  process.stdout.write(`[${args.dryRun ? 'DRY-RUN' : 'EXECUTE'}] 注销教师 ${args.teacherId} (${account.email})\n`);
  for (const action of actions) process.stdout.write(`  - ${action}\n`);

  if (args.dryRun) {
    process.stdout.write(JSON.stringify({ tool: 'deactivate-teacher', dryRun: true, teacherId: args.teacherId, actions }) + '\n');
    return;
  }

  // 2. 备份留证
  const { teacherDump, sharedDump } = await backupEvidence(sourceUrl, databaseName, rootDir);
  process.stdout.write(`backup evidence: teacher=${teacherDump ?? '(skipped)'} shared=${sharedDump}\n`);

  // 2.5 [--cleanup-media] 媒体清理：先留证后删（与备份留证纪律一致；失败即中止，不继续注销）
  let mediaCleanup = null;
  if (args.cleanupMedia) {
    mediaCleanup = await cleanupMediaEvidence(resolveMediaRoot(), args.teacherId, rootDir);
    process.stdout.write(
      mediaCleanup.skipped
        ? `media cleanup: skipped (${mediaCleanup.reason})\n`
        : `media cleanup: archived=${mediaCleanup.tarFile} sha256=${mediaCleanup.sha256}\n`,
    );
  }

  // 3. DROP 独立库（共享库跳过）
  if (databaseName !== SHARED_DB) {
    dropTeacherDatabase(maintenanceUrl, databaseName, databaseNameFromUrl(sourceUrl));
    process.stdout.write(`dropped database: ${databaseName}\n`);
  }

  // 4. 删除 TeacherRegistry + 会话
  const deleted = deleteTeacherRecord(sourceUrl, args.teacherId);
  if (!deleted) throw new Error('删除 TeacherRegistry 失败（记录不存在）——需人工核查');
  process.stdout.write(`deleted TeacherRegistry: ${args.teacherId}\n`);

  // 5. 注销登记簿
  const logPath = await appendRegistryLog(rootDir, {
    ts: new Date().toISOString(),
    operator: process.env.OPERATOR ?? 'ops-cli',
    teacherId: args.teacherId,
    email: account.email,
    displayName: account.displayName,
    databaseName,
    teacherDump,
    sharedDump,
    mediaCleanup: mediaCleanup
      ? { archived: !mediaCleanup.skipped, tarFile: mediaCleanup.tarFile, sha256: mediaCleanup.sha256, reason: mediaCleanup.reason }
      : undefined,
    action: 'deactivate',
  });
  process.stdout.write(`registry log: ${logPath}\n`);

  process.stdout.write(JSON.stringify({
    tool: 'deactivate-teacher',
    dryRun: false,
    teacherId: args.teacherId,
    email: account.email,
    databaseName,
    deleted: true,
    teacherDump,
    sharedDump,
    mediaCleanup,
    registryLog: logPath,
  }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
