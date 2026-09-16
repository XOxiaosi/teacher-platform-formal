import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetention, retentionTimestampFromKey } from '../lib/retention-policy.mjs';

const NOW = new Date('2026-09-16T00:00:00.000Z');

test('planRetention uses actual UTC age and expires at exactly the limit', () => {
  const plan = planRetention([
    { key: 'daily/teacher_20260817-000000.dump', kind: 'dump' }, // 30 days
    { key: 'daily/teacher_20260818-000000.dump', kind: 'dump' }, // 29 days
  ], { now: NOW, maxAgeDays: 30 });
  assert.deepEqual(plan.expire, ['daily/teacher_20260817-000000.dump']);
  assert.deepEqual(plan.retain, ['daily/teacher_20260818-000000.dump']);
  assert.deepEqual(plan.blocked, []);
  assert.equal(retentionTimestampFromKey('daily/teacher_20260817-000000.dump')?.toISOString(), '2026-08-17T00:00:00.000Z');
});

test('planRetention expires a complete artifact group together', () => {
  const plan = planRetention([
    { key: 'daily/teacher_20260801-000000.dump', kind: 'dump', groupKey: 'run-1' },
    { key: 'daily/MANIFEST-20260801-000000.json', kind: 'manifest', groupKey: 'run-1' },
    { key: 'deactivated/teacher_20260801-000000.tar', kind: 'media', groupKey: 'run-1' },
  ], { now: NOW, maxAgeDays: 30 });
  assert.equal(plan.expire.length, 3);
  assert.deepEqual(plan.blocked, []);
});

test('malformed, future, and unknown artifacts block their group', () => {
  const plan = planRetention([
    { key: 'daily/teacher_20260801-000000.dump', kind: 'dump', groupKey: 'bad' },
    { key: 'daily/broken.dump', kind: 'dump', groupKey: 'bad' },
    { key: 'monthly/teacher_20990101-000000.dump', kind: 'dump' },
    { key: 'daily/notes.txt', kind: 'unknown' },
  ], { now: NOW, maxAgeDays: 30 });
  assert.deepEqual(plan.expire, []);
  assert.ok(plan.blocked.includes('daily/teacher_20260801-000000.dump'));
  assert.ok(plan.blocked.includes('daily/broken.dump'));
  assert.ok(plan.blocked.includes('monthly/teacher_20990101-000000.dump'));
  assert.ok(plan.blocked.includes('daily/notes.txt'));
  assert.equal(plan.items.find((item) => item.key === 'daily/notes.txt')?.reason, '无法识别的备份格式');
});

test('invalid dates are rejected instead of normalized by JavaScript Date', () => {
  const plan = planRetention([
    { key: 'daily/teacher_20260231-000000.dump', kind: 'dump' },
  ], { now: NOW });
  assert.deepEqual(plan.expire, []);
  assert.deepEqual(plan.blocked, ['daily/teacher_20260231-000000.dump']);
});
