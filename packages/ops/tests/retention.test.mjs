import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRetention,
  computeDailyExpired,
  computeMonthlyExpired,
  parseBackupTimestamp,
} from '../lib/retention.mjs';

/** 内存 StorageBackend（模拟 LocalDirStorage 行为）。 */
function createMemoryStorage() {
  const map = new Map();
  return {
    async put(key, content) { map.set(key, content); },
    async get(key) { return map.get(key); },
    async list(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
    async delete(key) { map.delete(key); },
    _map: map,
  };
}

test('parseBackupTimestamp：解析命名时间戳', () => {
  const parsed = parseBackupTimestamp('teacher_platform_20260830-020000.dump');
  assert.ok(parsed);
  assert.equal(parsed.databaseName, 'teacher_platform');
  assert.equal(parsed.date.toISOString(), '2026-08-30T02:00:00.000Z');

  assert.equal(parseBackupTimestamp('not-a-dump.txt'), null);
  assert.equal(parseBackupTimestamp('teacher_platform_bad.dump'), null);
  assert.equal(parseBackupTimestamp('teacher_platform_20261399-020000.dump'), null);
});

test('computeDailyExpired：保留最近 7 个日备份，删除最旧', () => {
  const names = [];
  for (let day = 1; day <= 10; day += 1) {
    names.push(`teacher_platform_202608${String(day).padStart(2, '0')}-020000.dump`);
  }
  const expired = computeDailyExpired(names, { keepDays: 7 });
  assert.equal(expired.length, 3);
  assert.ok(expired.includes('teacher_platform_20260801-020000.dump'));
  assert.ok(expired.includes('teacher_platform_20260803-020000.dump'));
  assert.ok(!expired.includes('teacher_platform_20260804-020000.dump'));
});

test('computeDailyExpired：非命名文件忽略', () => {
  const names = [
    'teacher_platform_20260830-020000.dump',
    'MANIFEST-20260830-020000.json',
    'teacher_platform_20260829-020000.dump',
  ];
  const expired = computeDailyExpired(names, { keepDays: 7 });
  assert.deepEqual(expired, []);
});

test('computeMonthlyExpired：按月去重保留最近 12 个月', () => {
  const names = [];
  // 14 个有效月份：2025-01..2025-12 + 2026-01..2026-02
  for (let month = 1; month <= 12; month += 1) {
    names.push(`teacher_platform_2025${String(month).padStart(2, '0')}01-020000.dump`);
  }
  names.push('teacher_platform_20260101-020000.dump');
  names.push('teacher_platform_20260201-020000.dump');
  const expired = computeMonthlyExpired(names, { keepMonths: 12 });
  assert.equal(expired.length, 2);
  assert.ok(expired.includes('teacher_platform_20250101-020000.dump'));
  assert.ok(expired.includes('teacher_platform_20250201-020000.dump'));
  assert.ok(!expired.includes('teacher_platform_20250301-020000.dump'));
});

test('applyRetention：非每月 1 日只清 daily 过期，不归档', async () => {
  const storage = createMemoryStorage();
  const now = new Date('2026-08-30T02:00:00.000Z');
  const names = [];
  for (let day = 1; day <= 10; day += 1) {
    const name = `teacher_platform_202608${String(day).padStart(2, '0')}-020000.dump`;
    names.push(name);
    await storage.put(`daily/${name}`, Buffer.from(`dump-${day}`));
  }

  const result = await applyRetention(storage, { now, keepDays: 7 });
  assert.equal(result.deletedDaily.length, 3);
  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.deletedMonthly, []);
  // daily 剩 7 个
  const daily = await storage.list('daily/');
  assert.equal(daily.length, 7);
  assert.ok(!daily.includes('daily/teacher_platform_20260801-020000.dump'));
});

test('applyRetention：每月 1 日归档当月 1 日备份并轮转 monthly', async () => {
  const storage = createMemoryStorage();
  const now = new Date('2026-09-01T02:00:00.000Z');
  // 8 月 1 日（上个月份）与 9 月 1 日（当月）各一个备份
  await storage.put('daily/teacher_platform_20260801-020000.dump', Buffer.from('aug'));
  await storage.put('daily/teacher_platform_20260901-020000.dump', Buffer.from('sep'));
  // 13 个历史月度归档（2025-08 .. 2026-08）
  for (let month = 8; month <= 12; month += 1) {
    await storage.put(`monthly/teacher_platform_2025${String(month).padStart(2, '0')}01-020000.dump`, Buffer.from('old'));
  }
  for (let month = 1; month <= 8; month += 1) {
    await storage.put(`monthly/teacher_platform_2026${String(month).padStart(2, '0')}01-020000.dump`, Buffer.from('old'));
  }

  const result = await applyRetention(storage, { now, keepDays: 7, keepMonths: 12 });

  // 归档：9 月 1 日备份被复制到 monthly（8 月 1 日不是当月，不归档）
  assert.deepEqual(result.archived, ['teacher_platform_20260901-020000.dump']);
  const monthly = await storage.list('monthly/');
  assert.ok(monthly.includes('monthly/teacher_platform_20260901-020000.dump'));
  // monthly 轮转：14 份 → 保留 12 份（按月份去重），删最旧 2 份
  assert.equal(result.deletedMonthly.length, 2);
  assert.equal(monthly.length, 12);
});

test('applyRetention：dry-run 不删除不归档，返回清单', async () => {
  const storage = createMemoryStorage();
  const now = new Date('2026-08-30T02:00:00.000Z');
  for (let day = 1; day <= 8; day += 1) {
    await storage.put(`daily/teacher_platform_202608${String(day).padStart(2, '0')}-020000.dump`, Buffer.from('x'));
  }
  const result = await applyRetention(storage, { now, keepDays: 7, dryRun: true });
  assert.equal(result.deletedDaily.length, 1);
  assert.equal(result.dryRun, true);
  assert.equal((await storage.list('daily/')).length, 8); // 未删除
});

test('applyRetention：maxAgeDays 按年龄清理并保留未知项', async () => {
  const calls = [];
  const storage = {
    async list(prefix) {
      return prefix === 'daily/'
        ? ['daily/teacher_20260816-000000.dump', 'daily/teacher_20260820-000000.dump', 'daily/notes.txt']
        : [];
    },
    async get(key) { calls.push(`get:${key}`); throw new Error('dry-run must not read'); },
    async put(key) { calls.push(`put:${key}`); },
    async delete(key) { calls.push(`delete:${key}`); },
  };
  const result = await applyRetention(storage, { now: new Date('2026-09-16T00:00:00.000Z'), maxAgeDays: 30, dryRun: true });
  assert.deepEqual(result.deletedDaily, ['teacher_20260816-000000.dump']);
  assert.deepEqual(result.blocked, ['daily/notes.txt']);
  assert.deepEqual(calls, []);
});

test('applyRetention：maxAgeDays 执行删除只删除过期键', async () => {
  const deleted = [];
  const storage = {
    async list(prefix) { return prefix === 'daily/' ? ['daily/teacher_20260816-000000.dump'] : []; },
    async delete(key) { deleted.push(key); },
  };
  const result = await applyRetention(storage, { now: new Date('2026-09-16T00:00:00.000Z'), maxAgeDays: 30 });
  assert.deepEqual(result.deletedDaily, ['teacher_20260816-000000.dump']);
  assert.deepEqual(deleted, ['daily/teacher_20260816-000000.dump']);
});
