#!/usr/bin/env node
/** P6-EXPORT: teacher-scoped stored-data export. Business ciphertext remains
 * encrypted. Readable/decrypted export is a separate work package.
 * Usage: --teacher-id ID | --email EMAIL | --database-name teacher_db_ID
 *        [--out EMPTY_DIRECTORY] [--zip]
 * Every model/field requires explicit classification. No credentials, auth,
 * claim or lease tokens; no unfiltered database or directory exports.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName, SHARED_DB_NAME } from '../lib/db-safety.mjs';
import { createStoreOnlyZip } from '../lib/zip-writer.mjs';
import { databaseNameFromUrl, loadDatabaseUrl, projectRoot, psqlEnvironment,
  psqlQuery, quoteIdentifier, quoteLiteral, run, withPostgresBinPath } from '../lib/pg-utils.mjs';
import { EXPORT_POLICY, BUSINESS_TABLES, SHARED_DB_TABLES, validateExportPolicy,
  assertExportTeacherId, exportModelPolicy } from '../lib/teacher-export-policy.mjs';
import { chmodPrivate, collectExportZipEntries, exportMediaKeysFromRows,
  exportTeacherMedia, prepareExportDirectory, createTeacherExportStorage } from '../lib/teacher-export-media.mjs';
export { BUSINESS_TABLES, TEACHER_DB_TABLES, SHARED_DB_TABLES } from '../lib/teacher-export-policy.mjs';
export { chmodPrivate, collectExportZipEntries, exportMediaKeysFromRows, exportTeacherMedia } from '../lib/teacher-export-media.mjs';
const SHARED_DB = SHARED_DB_NAME;
const SHARED_TABLE_SET = new Set(SHARED_DB_TABLES);
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const writePrivate = (path, value) => writeFile(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

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

/** Only approved public account fields are selected, never passwordHash. */
export function readTeacherAccount(sourceUrl, { teacherId, email }) {
  validateExportPolicy();
  if (!teacherId && !email) throw new Error('SAFETY_BLOCK: account identity required');
  const where = teacherId ? `"id" = ${quoteLiteral(assertExportTeacherId(teacherId))}` : `"email" = ${quoteLiteral(email)}`;
  const fields = EXPORT_POLICY.TeacherRegistry.fields.map(quoteIdentifier).join(',');
  const rows = psqlQuery(sourceUrl, SHARED_DB, `SELECT row_to_json(t) FROM (SELECT ${fields} FROM "TeacherRegistry" WHERE ${where}) t`);
  if (rows.length > 1) throw new Error('SAFETY_BLOCK: ambiguous teacher account');
  return rows.length ? JSON.parse(rows[0]) : null;
}

/** Every table, including private databases, is filtered by the resolved owner. */
export function exportTable(sourceUrl, databaseName, table, teacherId) {
  const policy = exportModelPolicy(table);
  assertExportTeacherId(teacherId);
  if (policy.source === 'shared_db' && databaseName !== SHARED_DB) throw new Error('SAFETY_BLOCK: shared model source mismatch');
  const env = withPostgresBinPath({ ...psqlEnvironment(sourceUrl, databaseName), PGCLIENTENCODING: 'UTF8' });
  const fields = policy.fields.map(quoteIdentifier).join(',');
  const sql = `SELECT row_to_json(t) FROM (SELECT ${fields} FROM ${quoteIdentifier(table)} WHERE "teacherId" = ${quoteLiteral(teacherId)}) t`;
  const result = run('psql', ['-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env });
  if (result.error || result.status !== 0) throw new Error(`导出表 ${table} 失败；导出未完成`);
  return result.stdout.split(/\r?\n/).filter(line => line.length > 0);
}

/** A private database must have exactly one registered owner. */
export function lookupTeacherIdByDatabaseName(sourceUrl, databaseName) {
  if (databaseName === SHARED_DB) throw new Error('SAFETY_BLOCK: shared database requires teacher identity');
  const rows = psqlQuery(sourceUrl, SHARED_DB,
    `SELECT "id" FROM "TeacherRegistry" WHERE "databaseName" = ${quoteLiteral(databaseName)} LIMIT 2`);
  if (rows.length > 1) throw new Error('SAFETY_BLOCK: ambiguous registered database owner');
  return rows.length ? assertExportTeacherId(rows[0]) : null;
}
export function resolveMediaRoot() {
  return process.env.MEDIA_STORAGE_ROOT ? resolve(process.env.MEDIA_STORAGE_ROOT) : resolve(projectRoot, '.data');
}

export async function main(argv = process.argv.slice(2)) {
  validateExportPolicy();
  const args = parseArgs(argv);
  const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  let account;
  if (args.databaseName) {
    assertSafeTeacherDatabaseName(args.databaseName, sourceDatabaseName);
    const owner = lookupTeacherIdByDatabaseName(sourceUrl, args.databaseName);
    if (!owner) throw new Error('SAFETY_BLOCK: database has no registered teacher owner');
    account = readTeacherAccount(sourceUrl, { teacherId: owner });
  } else account = readTeacherAccount(sourceUrl, args);
  if (!account) throw new Error('教师不存在——请确认 TeacherRegistry 记录');
  const teacherId = assertExportTeacherId(account.id);
  const databaseName = account.databaseName;
  if (databaseName !== SHARED_DB) {
    assertSafeTeacherDatabaseName(databaseName, sourceDatabaseName);
    if (lookupTeacherIdByDatabaseName(sourceUrl, databaseName) !== teacherId) throw new Error('SAFETY_BLOCK: registered database owner mismatch');
  }
  const outDir = resolve(args.out ?? `export-${teacherId}`);
  await prepareExportDirectory(outDir, args.zip);
  const tablesDir = resolve(outDir, 'tables');
  // Exclusive creation also prevents two exporters from sharing an empty root.
  await mkdir(tablesDir, { mode: 0o700 });
  const manifest = {
    version: '1.1', exportedAt: new Date().toISOString(), teacherId, email: account.email, databaseName,
    representation: 'stored_encoding',
    note: '全部已分类教师业务表及媒体副本；业务密文保留原格式，本包不提供解密。认证资料、凭据、claim/lease token 已排除。',
    tables: [], media: [],
  };
  let mediaKeys = [];
  for (const table of BUSINESS_TABLES) {
    const shared = SHARED_TABLE_SET.has(table);
    const lines = exportTable(sourceUrl, shared ? SHARED_DB : databaseName, table, teacherId);
    if (table === 'MediaAsset') mediaKeys = exportMediaKeysFromRows(lines, teacherId);
    const file = `tables/${table.toLowerCase()}.jsonl`;
    const content = lines.length ? `${lines.join('\n')}\n` : '';
    await writePrivate(resolve(outDir, file), content);
    manifest.tables.push({ table, source: shared ? 'shared_db' : 'teacher_db', file, rows: lines.length, sha256: digest(content) });
  }
  if (mediaKeys.length) manifest.media = await exportTeacherMedia(
    createTeacherExportStorage(process.env, resolveMediaRoot(), teacherId), mediaKeys, outDir, teacherId);
  const accountContent = jsonText(account);
  manifest.accountSha256 = digest(accountContent);
  await writePrivate(resolve(outDir, 'account.json'), accountContent);
  await writePrivate(resolve(outDir, 'manifest.json'), jsonText(manifest));
  const entries = await collectExportZipEntries(outDir, manifest);
  let zipPath = null;
  let zipBytes = 0;
  if (args.zip) {
    zipPath = `${outDir}.zip`;
    const result = await createStoreOnlyZip({ outputPath: zipPath, entries, exclusive: true });
    zipBytes = result.sizeBytes;
    await chmodPrivate(zipPath);
  }
  process.stdout.write(JSON.stringify({ tool: 'export-teacher-data', teacherId, email: account.email,
    databaseName, out: outDir, zip: zipPath, zipBytes, tables: manifest.tables.length,
    totalRows: manifest.tables.reduce((sum, item) => sum + item.rows, 0),
    mediaFiles: manifest.media.length, mediaBytes: manifest.media.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    accountSha256: manifest.accountSha256, exportedAt: manifest.exportedAt }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
