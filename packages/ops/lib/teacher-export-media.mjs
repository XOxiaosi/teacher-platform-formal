/** P6-EXPORT local output and tenant media boundaries. Does not decrypt data. */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertExportTeacherId, BUSINESS_TABLES, validateExportPolicy } from './teacher-export-policy.mjs';
import { createStorageBackendFromEnv } from './storage-backend.mjs';

export async function chmodPrivate(path, isDir = false) {
  try { await chmod(path, isDir ? 0o700 : 0o600); } catch { /* Windows ACL is verified separately. */ }
}
export function assertOwnedMediaKey(key, teacherId) {
  assertExportTeacherId(teacherId);
  if (typeof key !== 'string' || /[\x00-\x1f\x7f]/.test(key) || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')
    || !key.startsWith(`media/${teacherId}/`) || key.split('/').length < 4) {
    throw new Error('SAFETY_BLOCK: media key does not belong to export teacher');
  }
  return key;
}
export function exportMediaKeysFromRows(lines, teacherId) {
  assertExportTeacherId(teacherId);
  const keys = new Set();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('SAFETY_BLOCK: invalid media export row'); }
    if (!row || row.teacherId !== teacherId) throw new Error('SAFETY_BLOCK: media row owner mismatch');
    keys.add(assertOwnedMediaKey(row.originalPath, teacherId));
  }
  return [...keys].sort();
}
export async function prepareExportDirectory(outDir, zip) {
  // Reject rather than remove/reuse prior material. Parent directories may be
  // user-selected; the export directory itself must be fresh or genuinely empty.
  try {
    const existing = await lstat(outDir);
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await readdir(outDir)).length) throw new Error('SAFETY_BLOCK: export output must be an empty directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (zip) {
    try { await lstat(`${outDir}.zip`); throw new Error('SAFETY_BLOCK: export zip already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(outDir, { recursive: true });
  await chmodPrivate(outDir, true);
}
function unsafeSource() {
  const error = new Error('SAFETY_BLOCK: local media source is not an owned regular file');
  error.code = 'UNSAFE_MEDIA_SOURCE';
  return error;
}
async function verifyLocalMediaPath(root, key) {
  let current = root;
  const segments = key.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw unsafeSource();
  }
  if (await realpath(current) !== current) throw unsafeSource();
  return current;
}
/** The generic storage adapter follows local symlinks. Privacy export must not:
 * an A-owned database key could otherwise resolve to a B-owned source file.
 * Validate every component and the opened file before reading any bytes. */
export function createTeacherExportStorage(env, defaultRoot, teacherId) {
  assertExportTeacherId(teacherId);
  const backend = (env.STORAGE_BACKEND ?? 'local').trim().toLowerCase();
  if (backend === 's3') return createStorageBackendFromEnv(env, defaultRoot);
  if (backend !== 'local') throw new Error('SAFETY_BLOCK: unknown export storage backend');
  const configuredRoot = resolve(env.STORAGE_LOCAL_ROOT ?? defaultRoot);
  return { async get(key) {
    assertOwnedMediaKey(key, teacherId);
    const root = await realpath(configuredRoot);
    const path = await verifyLocalMediaPath(root, key);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      // Repeat path checks after opening to catch a replaced directory or file.
      await verifyLocalMediaPath(root, key);
      const [actual, named] = await Promise.all([file.stat(), lstat(path)]);
      if (!actual.isFile() || actual.dev !== named.dev || actual.ino !== named.ino) throw unsafeSource();
      return await file.readFile();
    } finally { await file.close(); }
  } };
}
export async function exportTeacherMedia(storage, mediaKeys, outDir, teacherId) {
  assertExportTeacherId(teacherId);
  for (const key of mediaKeys) assertOwnedMediaKey(key, teacherId);
  const entries = [];
  for (const key of mediaKeys) {
    let content;
    try { content = await storage.get(key); }
    catch (error) {
      if (error.code === 'UNSAFE_MEDIA_SOURCE' || error.code === 'ELOOP') throw unsafeSource();
      if (['ENOENT', 'NoSuchKey'].includes(error.code)) { entries.push({ path: key, status: 'missing' }); continue; }
      throw new Error('媒体原件读取失败，导出未完成');
    }
    const target = resolve(outDir, key);
    const rel = relative(outDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('SAFETY_BLOCK: media output escapes export');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    await chmodPrivate(target);
    entries.push({ path: key, sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length });
  }
  return entries;
}

/** Only manifest-declared files may enter a package. Verify the bytes and reject
 * symlinks, unexpected files, missing declared files, or changed manifests. */
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function collectExportZipEntries(outDir, expectedManifest) {
  validateExportPolicy();
  const allowedFiles = new Map(BUSINESS_TABLES.map(table => [`tables/${table.toLowerCase()}.jsonl`, table]));
  const rootStat = await lstat(outDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('SAFETY_BLOCK: invalid export directory');
  const manifestPath = resolve(outDir, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('SAFETY_BLOCK: invalid export manifest file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (expectedManifest && JSON.stringify(expectedManifest) !== JSON.stringify(manifest)) throw new Error('SAFETY_BLOCK: export manifest changed');
  assertExportTeacherId(manifest.teacherId);
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.media) || typeof manifest.accountSha256 !== 'string') throw new Error('SAFETY_BLOCK: incomplete export manifest');
  const declared = new Map([['manifest.json', null], ['account.json', manifest.accountSha256]]);
  for (const item of manifest.tables) {
    if (!allowedFiles.has(item.file) || (item.table !== undefined && item.table !== allowedFiles.get(item.file)) || declared.has(item.file) || typeof item.sha256 !== 'string') throw new Error('SAFETY_BLOCK: invalid manifest table');
    declared.set(item.file, item.sha256);
  }
  for (const item of manifest.media) {
    assertOwnedMediaKey(item.path, manifest.teacherId);
    if (item.status === 'missing') continue;
    if (declared.has(item.path) || typeof item.sha256 !== 'string') throw new Error('SAFETY_BLOCK: invalid manifest media');
    declared.set(item.path, item.sha256);
  }
  const root = await realpath(outDir);
  const entries = [];
  async function walk(dir, prefix) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      const path = resolve(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('SAFETY_BLOCK: export symlinks are forbidden');
      if (item.isDirectory()) { await walk(path, name); continue; }
      if (!item.isFile() || !declared.has(name)) throw new Error('SAFETY_BLOCK: undeclared export file');
      const canonical = await realpath(path);
      if (relative(root, canonical).startsWith('..')) throw new Error('SAFETY_BLOCK: export file escapes root');
      const digest = declared.get(name);
      if (digest && await fileDigest(path) !== digest) throw new Error('SAFETY_BLOCK: export file digest mismatch');
      entries.push({ name, sourcePath: path });
    }
  }
  await walk(outDir, '');
  if (entries.length !== declared.size) throw new Error('SAFETY_BLOCK: declared export file missing');
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
