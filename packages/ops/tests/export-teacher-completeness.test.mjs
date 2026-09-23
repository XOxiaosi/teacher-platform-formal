import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeBaseUrl } from '../lib/db-safety.mjs';
import { loadDatabaseUrl, psqlMaintenance, quoteIdentifier, runMigrateDeploy, withDatabase } from '../lib/pg-utils.mjs';
import { BUSINESS_TABLES, EXPORT_POLICY } from '../lib/teacher-export-policy.mjs';
import { collectExportZipEntries } from '../lib/teacher-export-media.mjs';
import { exportTable, lookupTeacherIdByDatabaseName, main } from '../scripts/export-teacher-data.mjs';
import { modelId, seedBusiness, seedExcluded, removeSyntheticRows, syntheticRow } from './fixtures/teacher-export-synthetic.mjs';
import { crc32 } from '../lib/zip-writer.mjs';

if (!process.env.TEACHER_PLATFORM_ISOLATED_TEST_HARNESS?.startsWith('teacher-platform-pg17:')) throw new Error('Synthetic PostgreSQL harness required');
const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
const suffix = randomBytes(6).toString('hex');
const teachers = [`expA_${suffix}`, `expB_${suffix}`];
const database = `teacher_db_export_full_${suffix}`;
const shared = new PrismaClient({ datasources: { db: { url: withDatabase(sourceUrl, 'teacher_platform').toString() } } });
let privateDb;
let root;
let previousMediaRoot;

before(async () => {
  psqlMaintenance(withDatabase(sourceUrl, 'postgres'), `CREATE DATABASE ${quoteIdentifier(database)}`);
  runMigrateDeploy(withDatabase(sourceUrl, database));
  privateDb = new PrismaClient({ datasources: { db: { url: withDatabase(sourceUrl, database).toString() } } });
  for (const [index, teacher] of teachers.entries()) await shared.teacherRegistry.create({ data: {
    id: teacher, email: `${teacher}@example.invalid`, displayName: teacher, passwordHash: `SECRET_${teacher}_passwordHash`,
    databaseName: index === 0 ? database : 'teacher_platform',
  } });
  // A owns a private database containing accidental B rows. B uses the shared
  // transitional database, which also contains A decoys. Shared business tables
  // contain both teachers. All real foreign keys remain enabled.
  await seedBusiness(privateDb, teachers, 'teacher_db');
  await seedBusiness(shared, teachers, 'all');
  await seedExcluded(shared, teachers);
  root = await mkdtemp(join(tmpdir(), 'ops-export-complete-'));
  previousMediaRoot = process.env.MEDIA_STORAGE_ROOT;
  process.env.MEDIA_STORAGE_ROOT = join(root, 'source');
  for (const teacher of teachers) {
    const dir = join(process.env.MEDIA_STORAGE_ROOT, 'media', teacher, 'synthetic');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'original'), `SYNTHETIC_MEDIA_${teacher}`);
  }
});
after(async () => {
  if (previousMediaRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT;
  else process.env.MEDIA_STORAGE_ROOT = previousMediaRoot;
  if (privateDb) await privateDb.$disconnect();
  await removeSyntheticRows(shared, teachers);
  await shared.$disconnect();
  psqlMaintenance(withDatabase(sourceUrl, 'postgres'), `DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
  if (root) await rm(root, { recursive: true, force: true });
});

async function assertComplete(out, teacher) {
  const other = teachers.find(id => id !== teacher);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.teacherId, teacher);
  assert.equal(manifest.version, '1.1');
  assert.equal(manifest.representation, 'stored_encoding');
  assert.deepEqual(manifest.tables.map(item => item.table).sort(), [...BUSINESS_TABLES].sort());
  const entries = await collectExportZipEntries(out, manifest);
  assert.equal(entries.length, BUSINESS_TABLES.length + 3);
  for (const entry of entries) {
    const content = await readFile(entry.sourcePath, 'utf8');
    assert.equal(content.includes(other), false, `${entry.name} contains another teacher`);
    assert.equal(content.includes('SECRET_'), false, `${entry.name} contains credentials`);
    assert.doesNotMatch(content, /"(?:passwordHash|tokenHash|apiKeyEnc|claimToken|leaseToken)"/);
  }
  for (const item of manifest.tables) {
    assert.equal(item.rows, 1, item.table);
    const row = JSON.parse((await readFile(join(out, item.file), 'utf8')).trim());
    assert.equal(row.teacherId, teacher, item.table);
    assert.deepEqual(Object.keys(row).sort(), [...EXPORT_POLICY[item.table].fields].sort(), item.table);
    const seed = syntheticRow(item.table, teacher);
    // Check values as well as keys: raw strings, identifiers and JSON evidence
    // are preserved, without interpreting ciphertext as readable material.
    for (const field of EXPORT_POLICY[item.table].fields) {
      const expected = seed[field];
      if (expected instanceof Date) assert.equal(new Date(row[field]).valueOf(), expected.valueOf(), `${item.table}.${field}`);
      else assert.deepEqual(row[field], expected, `${item.table}.${field}`);
    }
  }
  assert.deepEqual(manifest.media.map(item => item.path), [`media/${teacher}/synthetic/original`]);
  const sourcePath = join(root, 'source', manifest.media[0].path);
  assert.equal(await readFile(sourcePath, 'utf8'), `SYNTHETIC_MEDIA_${teacher}`);
  return entries;
}

// Parse store-only local records and verify CRC, bytes and exact file names.
// Also verify central-directory entry count so no hidden trailing entry escapes.
async function assertZip(zipPath, entries) {
  const bytes = await readFile(zipPath);
  const actual = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const begin = offset + 30 + nameLength + extra;
    const body = bytes.subarray(begin, begin + size);
    assert.equal(crc32(body), bytes.readUInt32LE(offset + 14));
    assert.equal(actual.has(name), false);
    actual.set(name, body);
    offset = begin + size;
  }
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), entries.length);
  assert.deepEqual([...actual.keys()].sort(), entries.map(entry => entry.name).sort());
  for (const entry of entries) assert.deepEqual(actual.get(entry.name), await readFile(entry.sourcePath));
}

test('all 46 business models: private database A, shared database B and archive preserve only the selected teacher', async () => {
  for (const [index, teacher] of teachers.entries()) {
    const out = join(root, `export-${index}`);
    await main(['--teacher-id', teacher, '--out', out, '--zip']);
    const entries = await assertComplete(out, teacher);
    await assertZip(`${out}.zip`, entries);
  }
});
test('database-name resolves one registered teacher, filters contaminating rows, and email resolves canonical teacherId', async () => {
  const direct = join(root, 'direct');
  await main(['--database-name', database, '--out', direct]);
  await assertComplete(direct, teachers[0]);
  const email = join(root, 'email');
  await main(['--email', `${teachers[1]}@example.invalid`, '--out', email]);
  await assertComplete(email, teachers[1]);
});
test('no identity, unknown/excluded table, orphan/shared/ambiguous registered database cannot export', async () => {
  assert.throws(() => exportTable(sourceUrl, database, 'Student'), /SAFETY_BLOCK/);
  for (const table of ['SessionStore', 'TeacherInvitation', 'AdminAccount', 'AdminAuditLog', 'TeacherRegistry', 'Unknown']) {
    assert.throws(() => exportTable(sourceUrl, database, table, teachers[0]), /SAFETY_BLOCK/);
  }
  for (const name of ['teacher_db_unregistered', 'teacher_platform']) {
    const out = join(root, name);
    await assert.rejects(() => main(['--database-name', name, '--out', out]), /SAFETY_BLOCK/);
    assert.equal(existsSync(out), false);
  }
  await shared.teacherRegistry.update({ where: { id: teachers[1] }, data: { databaseName: database } });
  try {
    assert.throws(() => lookupTeacherIdByDatabaseName(sourceUrl, database), /ambiguous/);
    for (const identity of [['--teacher-id', teachers[0]], ['--database-name', database]]) {
      await assert.rejects(() => main([...identity, '--out', join(root, 'ambiguous')]), /ambiguous/);
    }
    assert.equal(existsSync(join(root, 'ambiguous')), false);
  } finally { await shared.teacherRegistry.update({ where: { id: teachers[1] }, data: { databaseName: 'teacher_platform' } }); }
});
test('a foreign media pointer is rejected without packaging or copying another teacher material', async () => {
  const id = modelId('MediaAsset', teachers[0]);
  await privateDb.mediaAsset.update({ where: { id }, data: { originalPath: `media/${teachers[1]}/synthetic/original` } });
  const out = join(root, 'foreign-media');
  try {
    await assert.rejects(() => main(['--teacher-id', teachers[0], '--out', out, '--zip']), /SAFETY_BLOCK/);
    assert.equal(existsSync(`${out}.zip`), false);
    assert.equal(existsSync(join(out, 'manifest.json')), false);
    assert.equal(existsSync(join(out, 'media')), false);
  } finally { await privateDb.mediaAsset.update({ where: { id }, data: { originalPath: `media/${teachers[0]}/synthetic/original` } }); }
});
test('an existing export cannot be reused, and concurrent writers cannot merge output directories', async () => {
  const existing = join(root, 'export-0');
  const original = await readFile(join(existing, 'manifest.json'));
  await assert.rejects(() => main(['--teacher-id', teachers[1], '--out', existing, '--zip']), /SAFETY_BLOCK/);
  assert.deepEqual(await readFile(join(existing, 'manifest.json')), original);
  const concurrent = join(root, 'concurrent');
  const results = await Promise.allSettled([1, 2].map(() => main(['--teacher-id', teachers[0], '--out', concurrent])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  await assertComplete(concurrent, teachers[0]);
});

test('main exporter rejects an owned media path whose local directory resolves into the other teacher', async () => {
  const id = modelId('MediaAsset', teachers[0]);
  const ownParent = join(root, 'source', 'media', teachers[0]);
  const foreign = join(root, 'source', 'media', teachers[1], 'synthetic');
  await symlink(foreign, join(ownParent, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await privateDb.mediaAsset.update({ where: { id }, data: { originalPath: `media/${teachers[0]}/linked/original` } });
  const out = join(root, 'source-symlink');
  try {
    await assert.rejects(() => main(['--teacher-id', teachers[0], '--out', out, '--zip']), /SAFETY_BLOCK/);
    assert.equal(existsSync(`${out}.zip`), false);
    assert.equal(existsSync(join(out, 'manifest.json')), false);
    assert.equal(existsSync(join(out, 'media')), false);
    assert.equal(await readFile(join(foreign, 'original'), 'utf8'), `SYNTHETIC_MEDIA_${teachers[1]}`);
  } finally { await privateDb.mediaAsset.update({ where: { id }, data: { originalPath: `media/${teachers[0]}/synthetic/original` } }); }
});
