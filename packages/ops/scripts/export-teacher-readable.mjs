#!/usr/bin/env node
/** P6-READABLE: teacher-scoped, strictly decrypted export. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBaseUrl, assertSafeTeacherDatabaseName, SHARED_DB_NAME } from '../lib/db-safety.mjs';
import { createStoreOnlyZip } from '../lib/zip-writer.mjs';
import { databaseNameFromUrl, loadDatabaseUrl, projectRoot, psqlEnvironment, psqlQuery, quoteLiteral, withPostgresBinPath, run } from '../lib/pg-utils.mjs';
import { BUSINESS_TABLES, SHARED_DB_TABLES, EXPORT_POLICY, validateExportPolicy, assertExportTeacherId } from '../lib/teacher-export-policy.mjs';
import { collectExportZipEntries, createTeacherExportStorage, prepareExportDirectory, chmodPrivate, assertOwnedMediaKey } from '../lib/teacher-export-media.mjs';
import { decryptReadableMedia, loadReadableKeys, readableManifest, readableRow } from '../lib/teacher-export-readable.mjs';
import { readTeacherAccount, lookupTeacherIdByDatabaseName, exportTable, resolveMediaRoot } from './export-teacher-data.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;
const writePrivate = (path, value) => writeFile(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
const sharedSet = new Set(SHARED_DB_TABLES);

export function parseReadableArgs(argv) {
  const filtered = argv.filter(arg => arg !== '--readable');
  const args = { teacherId: undefined, email: undefined, databaseName: undefined, out: undefined, zip: false };
  for (let i = 0; i < filtered.length; i += 1) {
    const arg = filtered[i];
    if (arg === '--teacher-id') args.teacherId = filtered[++i];
    else if (arg === '--email') args.email = filtered[++i];
    else if (arg === '--database-name') args.databaseName = filtered[++i];
    else if (arg === '--out') args.out = filtered[++i];
    else if (arg === '--zip') args.zip = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if ([args.teacherId, args.email, args.databaseName].filter(Boolean).length !== 1) {
    throw new Error('用法: export-teacher-readable --teacher-id <id> | --email <email> | --database-name <teacher_db_xxx> [--out <dir>] [--zip]');
  }
  return args;
}

function accountAndDatabase(sourceUrl, sourceDatabaseName, args) {
  let account;
  if (args.databaseName) {
    assertSafeTeacherDatabaseName(args.databaseName, sourceDatabaseName);
    const owner = lookupTeacherIdByDatabaseName(sourceUrl, args.databaseName);
    if (!owner) throw new Error('SAFETY_BLOCK: database has no registered teacher owner');
    account = readTeacherAccount(sourceUrl, { teacherId: owner });
  } else account = readTeacherAccount(sourceUrl, args);
  if (!account) throw new Error('教师不存在——请确认 TeacherRegistry 记录');
  const teacherId = assertExportTeacherId(account.id);
  if (account.databaseName !== SHARED_DB_NAME) {
    assertSafeTeacherDatabaseName(account.databaseName, sourceDatabaseName);
    if (lookupTeacherIdByDatabaseName(sourceUrl, account.databaseName) !== teacherId) throw new Error('SAFETY_BLOCK: registered database owner mismatch');
  }
  return { account, teacherId, databaseName: account.databaseName };
}

async function exportReadableMedia(sourceUrl, databaseName, teacherId, outDir, keys) {
  const lines = exportTable(sourceUrl, databaseName, 'MediaAsset', teacherId);
  const storage = createTeacherExportStorage(process.env, resolveMediaRoot(), teacherId);
  const entries = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    const key = assertOwnedMediaKey(row.originalPath, teacherId);
    let stored;
    try { stored = await storage.get(key); }
    catch (error) {
      if (['ENOENT', 'NoSuchKey'].includes(error?.code)) throw new Error('媒体原件缺失，导出未完成');
      throw error;
    }
    const plain = decryptReadableMedia(stored, row, keys);
    const target = resolve(outDir, key);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, plain, { flag: 'wx', mode: 0o600 });
    await chmodPrivate(target);
    entries.push({ path: key, sha256: digest(plain), sizeBytes: plain.length, representation: 'readable' });
  }
  return entries;
}

export async function main(argv = process.argv.slice(2)) {
  validateExportPolicy();
  const args = parseReadableArgs(argv);
  const keys = loadReadableKeys(process.env);
  const { url: sourceUrl } = assertSafeBaseUrl(loadDatabaseUrl());
  const sourceDatabaseName = databaseNameFromUrl(sourceUrl);
  const { account, teacherId, databaseName } = accountAndDatabase(sourceUrl, sourceDatabaseName, args);
  const outDir = resolve(args.out ?? `export-readable-${teacherId}`);
  await prepareExportDirectory(outDir, args.zip);
  const tablesDir = resolve(outDir, 'tables');
  await mkdir(tablesDir, { mode: 0o700 });
  const tables = [];
  for (const table of BUSINESS_TABLES) {
    const source = sharedSet.has(table) ? SHARED_DB_NAME : databaseName;
    const storedLines = exportTable(sourceUrl, source, table, teacherId);
    const readableLines = storedLines.map(line => JSON.stringify(readableRow(table, JSON.parse(line), keys)));
    const content = readableLines.length ? `${readableLines.join('\n')}\n` : '';
    const file = `tables/${table.toLowerCase()}.jsonl`;
    await writePrivate(resolve(outDir, file), content);
    tables.push({ table, source: sharedSet.has(table) ? 'shared_db' : 'teacher_db', file, rows: readableLines.length, sha256: digest(content) });
  }
  const media = await exportReadableMedia(sourceUrl, databaseName, teacherId, outDir, keys);
  const accountContent = jsonText(account);
  await writePrivate(resolve(outDir, 'account.json'), accountContent);
  const manifest = readableManifest({ teacherId, account, databaseName, tables, media });
  manifest.accountSha256 = digest(accountContent);
  await writePrivate(resolve(outDir, 'manifest.json'), jsonText(manifest));
  const entries = await collectExportZipEntries(outDir, manifest);
  let zipPath = null; let zipBytes = 0;
  if (args.zip) {
    zipPath = `${outDir}.zip`;
    const result = await createStoreOnlyZip({ outputPath: zipPath, entries, exclusive: true });
    zipBytes = result.sizeBytes;
    await chmodPrivate(zipPath);
  }
  const result = { tool: 'export-teacher-readable', teacherId, email: account.email, databaseName, out: outDir, zip: zipPath,
    zipBytes, representation: 'readable', scope: 'records_and_media', complete: true, tables: tables.length,
    totalRows: tables.reduce((sum, item) => sum + item.rows, 0), mediaFiles: media.length,
    mediaBytes: media.reduce((sum, item) => sum + item.sizeBytes, 0), exportedAt: manifest.exportedAt };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
