import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeInitDatabaseUrl,
  initializeLocalSharedDatabase,
} from '../scripts/db-init-local.mjs';

test('Init 仅允许本机 PostgreSQL 且数据库名精确 teacher_platform', () => {
  for (const value of [
    'mysql://localhost/teacher_platform',
    'postgresql://db.example.com/teacher_platform',
    'postgresql://localhost/postgres',
    'postgresql://127.0.0.1/teacher_db_demo',
  ]) {
    assert.throws(() => assertSafeInitDatabaseUrl(value), /SAFETY_BLOCK/);
  }
  assert.equal(
    assertSafeInitDatabaseUrl('postgresql://user:secret@[::1]:5432/teacher_platform').databaseName,
    'teacher_platform',
  );
});

test('Init：库不存在才 CREATE，随后只 migrate deploy；不含 drop/reset/push/terminate', () => {
  const events = [];
  const result = initializeLocalSharedDatabase({
    databaseUrl: 'postgresql://user:secret@127.0.0.1:5432/teacher_platform',
    queryMaintenance: (_url, sql) => {
      events.push(`sql:${sql}`);
      return sql.startsWith('SELECT') ? [] : [];
    },
    migrateDeploy: (url) => events.push(`migrate:${url.pathname}`),
  });
  assert.deepEqual(result, { created: true, migrated: true });
  assert.equal(events.filter((item) => item.startsWith('sql:CREATE DATABASE')).length, 1);
  assert.equal(events.at(-1), 'migrate:/teacher_platform');
  assert.doesNotMatch(events.join('\n'), /DROP|reset|db push|terminate/i);
});

test('Init：已存在时幂等，不 CREATE，仍运行 migrate deploy', () => {
  const events = [];
  const result = initializeLocalSharedDatabase({
    databaseUrl: 'postgresql://127.0.0.1/teacher_platform',
    queryMaintenance: (_url, sql) => {
      events.push(`sql:${sql}`);
      return ['1'];
    },
    migrateDeploy: () => events.push('migrate'),
  });
  assert.deepEqual(result, { created: false, migrated: true });
  assert.equal(events.filter((item) => item.startsWith('sql:CREATE')).length, 0);
  assert.equal(events.at(-1), 'migrate');
});

test('Init：远端/非共享库拒绝发生在任何 SQL 或 migrate 之前', () => {
  const events = [];
  assert.throws(
    () => initializeLocalSharedDatabase({
      databaseUrl: 'postgresql://db.example.com/teacher_platform',
      queryMaintenance: () => events.push('sql'),
      migrateDeploy: () => events.push('migrate'),
    }),
    /SAFETY_BLOCK/,
  );
  assert.deepEqual(events, []);
});

test('Init：migration 失败保留已创建数据库，不执行自动清理', () => {
  const events = [];
  assert.throws(
    () => initializeLocalSharedDatabase({
      databaseUrl: 'postgresql://127.0.0.1/teacher_platform',
      queryMaintenance: (_url, sql) => {
        events.push(sql);
        return [];
      },
      migrateDeploy: () => {
        events.push('migrate');
        throw new Error('synthetic migration failure');
      },
    }),
    /synthetic migration failure/,
  );
  assert.doesNotMatch(events.join('\n'), /DROP|terminate/i);
});
