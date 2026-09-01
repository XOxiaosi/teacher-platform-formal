import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupFailedDrill,
  parseArgs,
} from '../scripts/db-restore.mjs';

test('db-restore drill：失败默认保留目标库供取证', () => {
  const calls = [];
  const result = cleanupFailedDrill({
    cleanupOnFailure: false,
    maintenanceUrl: new URL('postgresql://localhost/postgres'),
    target: 'teacher_db_demo_restore_failed',
    terminateAndDropImpl: (...args) => calls.push(args),
  });

  assert.deepEqual(result, { cleaned: false, retained: true });
  assert.deepEqual(calls, []);
});

test('db-restore drill：仅显式 --cleanup-on-failure 才清理失败目标库', () => {
  const calls = [];
  const maintenanceUrl = new URL('postgresql://localhost/postgres');
  const target = 'teacher_db_demo_restore_failed';
  const result = cleanupFailedDrill({
    cleanupOnFailure: true,
    maintenanceUrl,
    target,
    terminateAndDropImpl: (...args) => calls.push(args),
  });

  assert.deepEqual(result, { cleaned: true, retained: false });
  assert.deepEqual(calls, [[maintenanceUrl, target]]);
});

test('parseArgs：cleanup 是 drill-only 显式 opt-in，默认关闭', () => {
  const base = ['--database', 'teacher_db_demo', '--from', 'demo.dump'];
  assert.equal(parseArgs([...base, '--target', 'teacher_db_demo_restore_failed']).cleanupOnFailure, false);
  assert.equal(parseArgs([...base, '--target', 'teacher_db_demo_restore_failed', '--cleanup-on-failure']).cleanupOnFailure, true);
  assert.throws(
    () => parseArgs([...base, '--cleanup-on-failure']),
    /SAFETY_BLOCK.*--target/,
  );
});
