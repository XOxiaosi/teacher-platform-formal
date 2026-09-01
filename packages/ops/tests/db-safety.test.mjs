import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBaseUrl,
  assertSafeTeacherDatabaseName,
  assertSafeRestoreDatabaseName,
  isRestoreDatabaseName,
} from '../lib/db-safety.mjs';

test('assertSafeBaseUrl：接受本机 postgres URL', () => {
  const { url, databaseName } = assertSafeBaseUrl('postgresql://user:pass@127.0.0.1:5432/teacher_platform');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(databaseName, 'teacher_platform');
  assertSafeBaseUrl('postgres://user:pass@localhost/teacher_platform');
  assertSafeBaseUrl('postgresql://user:pass@[::1]:5432/teacher_platform');
});

test('assertSafeBaseUrl：拒绝非 postgres 协议', () => {
  assert.throws(() => assertSafeBaseUrl('mysql://u:p@localhost/db'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeBaseUrl('https://example.com/db'), /SAFETY_BLOCK/);
});

test('assertSafeBaseUrl：拒绝非本机 host', () => {
  assert.throws(() => assertSafeBaseUrl('postgresql://u:p@remote.example.com:5432/db'), /SAFETY_BLOCK/);
});

test('assertSafeBaseUrl：拒绝缺库名', () => {
  assert.throws(() => assertSafeBaseUrl('postgresql://u:p@localhost:5432/'), /SAFETY_BLOCK/);
});

test('assertSafeTeacherDatabaseName：接受合法教师库名', () => {
  assert.equal(assertSafeTeacherDatabaseName('teacher_db_001', 'teacher_platform'), 'teacher_db_001');
  assert.equal(assertSafeTeacherDatabaseName('teacher_db_abc_02', 'teacher_platform'), 'teacher_db_abc_02');
});

test('assertSafeTeacherDatabaseName：拒绝非 teacher_db_ 前缀', () => {
  assert.throws(() => assertSafeTeacherDatabaseName('other_db', 'teacher_platform'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTeacherDatabaseName('teacher_platform', 'teacher_platform'), /SAFETY_BLOCK/);
});

test('assertSafeTeacherDatabaseName：拒绝危险字符', () => {
  assert.throws(() => assertSafeTeacherDatabaseName('teacher_db_x;DROP', 'teacher_platform'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTeacherDatabaseName('teacher_db_x-y', 'teacher_platform'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTeacherDatabaseName('Teacher_Db_01', 'teacher_platform'), /SAFETY_BLOCK/);
});

test('assertSafeTeacherDatabaseName：拒绝等于源库/系统库', () => {
  assert.throws(() => assertSafeTeacherDatabaseName('teacher_db_001', 'teacher_db_001'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTeacherDatabaseName('postgres', 'teacher_platform'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeTeacherDatabaseName('template0', 'teacher_platform'), /SAFETY_BLOCK/);
});

test('assertSafeRestoreDatabaseName：接受两种演练库形态', () => {
  assert.equal(assertSafeRestoreDatabaseName('teacher_db_001_restore_abc123'), 'teacher_db_001_restore_abc123');
  assert.equal(assertSafeRestoreDatabaseName('teacher_platform_restore_abc123'), 'teacher_platform_restore_abc123');
  assert.equal(assertSafeRestoreDatabaseName('teacher_db_001_restore_9f2c4a'), 'teacher_db_001_restore_9f2c4a');
});

test('assertSafeRestoreDatabaseName：拒绝非演练形态', () => {
  assert.throws(() => assertSafeRestoreDatabaseName('teacher_db_001'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeRestoreDatabaseName('teacher_platform'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeRestoreDatabaseName('teacher_db_001_restore_'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeRestoreDatabaseName('teacher_db_001_restore_abc-1'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeRestoreDatabaseName('postgres'), /SAFETY_BLOCK/);
  assert.throws(() => assertSafeRestoreDatabaseName('teacher_db_001_restore_abc;drop'), /SAFETY_BLOCK/);
});

test('isRestoreDatabaseName：识别形态（不抛错）', () => {
  assert.equal(isRestoreDatabaseName('teacher_db_001_restore_abc123'), true);
  assert.equal(isRestoreDatabaseName('teacher_platform_restore_abc123'), true);
  assert.equal(isRestoreDatabaseName('teacher_db_001'), false);
  assert.equal(isRestoreDatabaseName('postgres'), false);
});
