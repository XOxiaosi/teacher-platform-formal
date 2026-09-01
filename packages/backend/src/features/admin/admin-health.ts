import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { isDatabaseMissingError } from '../../shared/prisma-errors/index.js';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';
import { isSafeAdminDatabaseName } from './teacher-overview.js';

/**
 * 系统健康聚合（P7 渠道线 A4，设计 §2.3）。
 *
 * - ready：共享库 SELECT 1（与 /health/ready 同语义）+ 池状态（hotDbCount）；
 * - teacherDbs：枚举 TeacherRegistry.databaseName（去重 + isSafeAdminDatabaseName 逐项校验，
 *   镜像 ops assertSafeTeacherDatabaseName + 允许默认共享库）→ 逐库 SELECT 1 + _prisma_migrations
 *   计数 → 分类 ok / missing / migrationBehind / unreachable（并发上限 4 + 单库 2s 超时 +
 *   全局 10s 期限，超时部分结果 + degraded）；单库故障不影响整体（不 500）；
 * - backup：BACKUP_ROOT（env > 平台默认）daily/MANIFEST-*.json 最新解析 → 摘要；目录缺失 → exists:false；
 * - migrations：共享库 _prisma_migrations 已应用数 + public 表数（动态计算，不硬编码）；
 * - metrics：进程内 /metrics 未挂载（t39 预留位；t41 为日志聚合脚本）→ available:false 显式标注。
 */

export interface TeacherDbHealthEntry {
  databaseName: string;
  status: 'ok' | 'missing' | 'migrationBehind' | 'unreachable';
  detail: string;
}

export interface AdminHealthSnapshot {
  ready: {
    ok: boolean;
    sharedDb: 'ok' | 'unreachable';
    poolState: { hotDbCount: number };
  };
  teacherDbs: {
    total: number;
    ok: number;
    missing: number;
    migrationBehind: number;
    unreachable: number;
    degraded: boolean;
    checked: TeacherDbHealthEntry[];
  };
  backup: {
    exists: boolean;
    latestRunId?: string;
    latestAt?: string;
    okCount?: number;
    failedCount?: number;
  };
  migrations: { shared: { migrations: number; tables: number } };
  metrics: { available: false; reason: string };
}

export interface AdminHealthInput {
  /** 教师库巡检并发上限，默认 4 */
  concurrency?: number;
  /** 单库超时（ms），默认 2000 */
  perDbTimeoutMs?: number;
  /** 全局期限（ms），默认 10_000 */
  deadlineMs?: number;
  /** 备份根目录（测试注入；缺省 env BACKUP_ROOT > 平台默认） */
  backupRoot?: string;
}

export function defaultBackupRoot(): string {
  if (process.env.BACKUP_ROOT) return process.env.BACKUP_ROOT;
  return process.platform === 'win32'
    ? join(process.env.TEMP ?? 'C:/Windows/Temp', 'teacher-platform-backups')
    : '/var/backups/teacher-platform';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('db check timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 单库巡检：SELECT 1（可达）+ _prisma_migrations 计数 vs 共享库期望 → 分类。不抛错（异常归 unreachable）。 */
async function checkOneTeacherDb(
  pool: DatabaseClientPool,
  databaseName: string,
  expectedMigrations: number,
  timeoutMs: number,
): Promise<TeacherDbHealthEntry> {
  let client: PrismaClient;
  try {
    client = await pool.acquire(databaseName);
  } catch (error) {
    return { databaseName, status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    await withTimeout(client.$queryRaw(Prisma.sql`SELECT 1`), timeoutMs);
    const migrations = await withTimeout(
      client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*)::int8 AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`),
      timeoutMs,
    );
    const applied = Number(migrations[0]?.count ?? 0);
    if (applied < expectedMigrations) {
      return { databaseName, status: 'migrationBehind', detail: `migrations=${applied}<${expectedMigrations}` };
    }
    return { databaseName, status: 'ok', detail: `migrations=${applied}` };
  } catch (error) {
    // 库不存在（P1003）→ missing（与 db-health-check 分类一致）；其余 → unreachable
    if (isDatabaseMissingError(error)) {
      return { databaseName, status: 'missing', detail: 'database does not exist' };
    }
    return { databaseName, status: 'unreachable', detail: 'SELECT 1 或迁移计数失败' };
  } finally {
    pool.release(databaseName);
  }
}

export async function getAdminHealth(
  registryPrisma: Pick<PrismaClient, 'teacherRegistry' | '$queryRaw'>,
  pool: DatabaseClientPool,
  input: AdminHealthInput = {},
): Promise<AdminHealthSnapshot> {
  const concurrency = input.concurrency ?? 4;
  const perDbTimeoutMs = input.perDbTimeoutMs ?? 2000;
  const deadlineMs = input.deadlineMs ?? 10_000;
  const backupRoot = input.backupRoot ?? defaultBackupRoot();

  const deadline = performance.now() + deadlineMs;

  // 1) 共享库可达 + 池状态
  let sharedDb: 'ok' | 'unreachable' = 'unreachable';
  let migrations = 0;
  let tables = 0;
  try {
    await registryPrisma.$queryRaw(Prisma.sql`SELECT 1`);
    sharedDb = 'ok';
  } catch {
    sharedDb = 'unreachable';
  }
  if (sharedDb === 'ok') {
    try {
      const rows = await registryPrisma.$queryRaw<Array<{ migrations: bigint; tables: bigint }>>(
        Prisma.sql`SELECT
          (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int8 AS migrations,
          (SELECT count(*) FROM pg_tables WHERE schemaname='public')::int8 AS tables`,
      );
      migrations = Number(rows[0]?.migrations ?? 0);
      tables = Number(rows[0]?.tables ?? 0);
    } catch {
      // 迁移计数失败不致命
    }
  }

  // 2) 教师库巡检（去重 + 安全校验 + 并发上限 + 全局期限）
  const teacherDbs: TeacherDbHealthEntry[] = [];
  let degraded = false;
  if (sharedDb === 'ok') {
    try {
      const rows = await registryPrisma.teacherRegistry.findMany({
        select: { databaseName: true },
        distinct: ['databaseName'],
        where: { databaseName: { not: '' } },
      });
      const safeNames = rows
        .map((row) => row.databaseName)
        .filter((name): name is string => isSafeAdminDatabaseName(name));
      let index = 0;
      while (index < safeNames.length && performance.now() < deadline) {
        const batch = safeNames.slice(index, index + concurrency);
        index += concurrency;
        const results = await Promise.allSettled(
          batch.map((name) => checkOneTeacherDb(pool, name, migrations, perDbTimeoutMs)),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') teacherDbs.push(result.value);
          else teacherDbs.push({ databaseName: 'unknown', status: 'unreachable', detail: '巡检异常' });
        }
      }
      if (index < safeNames.length) degraded = true; // 全局期限截断
    } catch {
      degraded = true;
    }
  } else {
    degraded = true;
  }

  const summary = {
    total: teacherDbs.length,
    ok: teacherDbs.filter((item) => item.status === 'ok').length,
    missing: teacherDbs.filter((item) => item.status === 'missing').length,
    migrationBehind: teacherDbs.filter((item) => item.status === 'migrationBehind').length,
    unreachable: teacherDbs.filter((item) => item.status === 'unreachable').length,
  };

  // 3) 备份状态：BACKUP_ROOT/daily/MANIFEST-*.json 最新解析
  let backup: AdminHealthSnapshot['backup'] = { exists: false };
  try {
    const dailyDir = resolve(backupRoot, 'daily');
    const files = (await readdir(dailyDir)).filter((file) => /^MANIFEST-.*\.json$/.test(file)).sort();
    const latestFile = files[files.length - 1];
    if (latestFile) {
      const raw = await readFile(join(dailyDir, latestFile), 'utf8');
      const manifest = JSON.parse(raw) as {
        runId?: string;
        total?: number;
        ok?: number;
        failed?: number;
      };
      backup = {
        exists: true,
        latestRunId: manifest.runId,
        latestAt: latestFile.replace(/^MANIFEST-(.+)\.json$/, '$1'),
        okCount: manifest.ok,
        failedCount: manifest.failed,
      };
    }
  } catch {
    backup = { exists: false }; // 目录/解析失败 → 无备份（非 500）
  }

  return {
    ready: {
      ok: sharedDb === 'ok',
      sharedDb,
      poolState: { hotDbCount: pool.size() },
    },
    teacherDbs: { ...summary, degraded, checked: teacherDbs },
    backup,
    migrations: { shared: { migrations, tables } },
    metrics: {
      available: false,
      reason: '进程内 /metrics 未挂载（t39 预留挂载位；t41 metrics-aggregate 为日志聚合脚本，独立运行）',
    },
  };
}
