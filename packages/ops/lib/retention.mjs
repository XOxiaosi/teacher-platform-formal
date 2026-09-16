/**
 * 备份保留策略（P7 B1，t12 设计 §3.3）。
 *
 * - daily：保留最近 keepDays（默认 7）个日备份，超期删除；
 * - monthly：每月 1 日把当日备份归档到 monthly/，保留最近 keepMonths（默认 12）份。
 *
 * 命名规则（t12 §2.1）：<databaseName>_<YYYYMMDD>-<HHMMSS>.dump。
 * 清理基于命名时间戳排序（不依赖文件 mtime，跨机器/复制后仍稳定）。
 * dry-run：只算不动，返回将被处理清单。
 */

import { planRetention, retentionTimestampFromKey } from './retention-policy.mjs';

/** 从 dump 文件名解析时间戳；不匹配返回 null。 */
export function parseBackupTimestamp(filename) {
  const match = /^(.+)_(\d{8})-(\d{6})\.dump$/.exec(filename);
  if (!match) return null;
  const [, databaseName, ymd, hms] = match;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { databaseName, date };
}

/** 计算 daily 层过期文件（按时间戳降序，保留最近 keepDays 个）。 */
export function computeDailyExpired(filenames, { keepDays = 7 } = {}) {
  const dated = filenames
    .map((name) => ({ name, parsed: parseBackupTimestamp(name) }))
    .filter((item) => item.parsed !== null)
    .sort((a, b) => b.parsed.date.getTime() - a.parsed.date.getTime());
  return dated.slice(keepDays).map((item) => item.name);
}

/** 计算 monthly 层过期文件（按 YYYY-MM 去重保留最近 keepMonths 个月份，其余删除）。 */
export function computeMonthlyExpired(filenames, { keepMonths = 12 } = {}) {
  const byMonth = new Map();
  for (const name of filenames) {
    const parsed = parseBackupTimestamp(name);
    if (!parsed) continue;
    const key = `${parsed.date.getUTCFullYear()}-${parsed.date.getUTCMonth()}`;
    const existing = byMonth.get(key);
    if (!existing || parsed.date.getTime() > existing.parsed.date.getTime()) {
      byMonth.set(key, { name, parsed });
    }
  }
  const sorted = [...byMonth.values()].sort(
    (a, b) => b.parsed.date.getTime() - a.parsed.date.getTime(),
  );
  return sorted.slice(keepMonths).map((item) => item.name);
}

/**
 * Apply the age-based policy used by production backups.  The older count-based
 * behavior remains available when maxAgeDays is omitted for compatibility with
 * existing callers.  A dry run only lists keys; it never reads, writes, or
 * deletes backup bytes.
 */
async function applyAgeRetention(storage, options) {
  const {
    now = new Date(), maxAgeDays = 30, dryRun = false,
    dailyPrefix = 'daily/', monthlyPrefix = 'monthly/', deactivatedPrefix = 'deactivated/',
  } = options;
  const prefixes = [
    [dailyPrefix, 'dump'],
    [monthlyPrefix, 'dump'],
    [deactivatedPrefix, 'media'],
  ];
  const inventory = [];
  for (const [prefix, defaultKind] of prefixes) {
    const keys = await storage.list(prefix);
    for (const key of keys) {
      const base = key.slice(prefix.length);
      const kind = base.startsWith('MANIFEST-') ? 'manifest' : defaultKind;
      inventory.push({ key, kind, timestamp: retentionTimestampFromKey(key) });
    }
  }
  const plan = planRetention(inventory, { now, maxAgeDays });
  const expire = new Set(plan.expire);
  const deletedDaily = plan.expire.filter((key) => key.startsWith(dailyPrefix));
  const deletedMonthly = plan.expire.filter((key) => key.startsWith(monthlyPrefix));
  const deletedDeactivated = plan.expire.filter((key) => key.startsWith(deactivatedPrefix));
  if (!dryRun) {
    for (const key of expire) await storage.delete(key);
  }
  return {
    archived: [],
    deletedDaily: deletedDaily.map((key) => key.slice(dailyPrefix.length)),
    deletedMonthly: deletedMonthly.map((key) => key.slice(monthlyPrefix.length)),
    deletedDeactivated: deletedDeactivated.map((key) => key.slice(deactivatedPrefix.length)),
    blocked: plan.blocked,
    plan,
    dryRun,
  };
}

/**
 * 执行保留策略。
 * @param {import('./storage-backend.mjs').StorageBackend} storage
 * @param {object} options
 *   - now: 当前时间（测试注入；默认 new Date()）
 *   - keepDays / keepMonths
 *   - dryRun: 只计算不删除/不归档
 *   - archiveMonthly: 每月 1 日把当日备份复制到 monthly/（默认 true）
 * @returns {Promise<{archived: string[], deletedDaily: string[], deletedMonthly: string[], dryRun: boolean}>}
 */
export async function applyRetention(storage, options = {}) {
  if (options.maxAgeDays !== undefined) return applyAgeRetention(storage, options);
  const {
    now = new Date(),
    keepDays = 7,
    keepMonths = 12,
    dryRun = false,
    archiveMonthly = true,
    dailyPrefix = 'daily/',
    monthlyPrefix = 'monthly/',
  } = options;

  // list() 返回带前缀的 key（如 daily/xxx.dump），处理时剥离前缀、写回时再补。
  const stripPrefix = (key, prefix) => (key.startsWith(prefix) ? key.slice(prefix.length) : key);
  const dailyNames = (await storage.list(dailyPrefix)).map((key) => stripPrefix(key, dailyPrefix));

  // 先归档（每月 1 日把当月 1 日备份复制到 monthly/），再对更新后的 monthly 集合做轮转。
  const archived = [];
  const isFirstOfMonth = now.getUTCDate() === 1;
  if (archiveMonthly && isFirstOfMonth) {
    for (const name of dailyNames) {
      const parsed = parseBackupTimestamp(name);
      if (!parsed) continue;
      // 只归档「当月 1 日」的备份（月度归档语义：每月 1 日把当日备份归档）
      const isFirstOfItsMonth = parsed.date.getUTCDate() === 1
        && parsed.date.getUTCFullYear() === now.getUTCFullYear()
        && parsed.date.getUTCMonth() === now.getUTCMonth();
      if (!isFirstOfItsMonth) continue;
      const content = await storage.get(`${dailyPrefix}${name}`);
      if (!dryRun) {
        await storage.put(`${monthlyPrefix}${name}`, content);
      }
      archived.push(name);
    }
  }

  const monthlyNames = (await storage.list(monthlyPrefix)).map((key) => stripPrefix(key, monthlyPrefix));
  const deletedDaily = computeDailyExpired(dailyNames, { keepDays });
  const deletedMonthly = computeMonthlyExpired(monthlyNames, { keepMonths });

  if (!dryRun) {
    for (const name of deletedDaily) {
      await storage.delete(`${dailyPrefix}${name}`);
    }
    for (const name of deletedMonthly) {
      await storage.delete(`${monthlyPrefix}${name}`);
    }
  }

  return { archived, deletedDaily, deletedMonthly, dryRun };
}
