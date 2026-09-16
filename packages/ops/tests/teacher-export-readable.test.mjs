import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';
import { decryptReadableJson, decryptReadableMedia, decryptReadableText, loadReadableKeys, readableManifest, readableRow } from '../lib/teacher-export-readable.mjs';

const key = Buffer.alloc(32, 7);
function fieldCipher(plain, legacy = false) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]); const tag = cipher.getAuthTag();
  return legacy
    ? `v1:${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`
    : `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}
function mediaCipher(plain) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]); const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('TPMEDENC'), Buffer.from([1]), iv, tag, encrypted]);
}
const keys = { field: key, media: key };

test('readable 字段严格解密新旧格式并拒绝损坏密文', () => {
  assert.equal(decryptReadableText(fieldCipher('中文内容'), key), '中文内容');
  assert.equal(decryptReadableText(fieldCipher('legacy', true), key), 'legacy');
  assert.equal(decryptReadableText('旧系统明文', key), '旧系统明文');
  assert.throws(() => decryptReadableText('enc:v1:broken', key), /SAFETY_BLOCK/);
  assert.throws(() => decryptReadableJson(fieldCipher('not-json'), key), /SAFETY_BLOCK/);
  assert.deepEqual(decryptReadableJson(fieldCipher('{"a":1}'), key), { a: 1 });
});

test('readableRow 只按显式字段表转换，保留非加密字段', () => {
  const row = readableRow('ParentFeedback', {
    id: 'f1', title: fieldCipher('标题'), content: fieldCipher('正文'), parentName: null,
    requestFingerprint: 'a'.repeat(64), creationReceiptCiphertext: fieldCipher('{"version":1}'),
  }, keys);
  assert.deepEqual(row, {
    id: 'f1', title: '标题', content: '正文', parentName: null,
    requestFingerprint: 'a'.repeat(64), creationReceiptCiphertext: { version: 1 },
  });
});

test('readable media 解密后校验 sha256/大小，旧明文只在 encryptionVersion=null 时兼容', () => {
  const plain = Buffer.from('synthetic-media-中文');
  const row = { encryptionVersion: 'aes-256-gcm', sha256: createHash('sha256').update(plain).digest('hex'), sizeBytes: plain.length };
  assert.deepEqual(decryptReadableMedia(mediaCipher(plain), row, keys), plain);
  assert.deepEqual(decryptReadableMedia(plain, { ...row, encryptionVersion: null }, keys), plain);
  assert.throws(() => decryptReadableMedia(plain, row, keys), /SAFETY_BLOCK/);
  assert.throws(() => decryptReadableMedia(mediaCipher(plain), { ...row, sizeBytes: plain.length + 1 }, keys), /SAFETY_BLOCK/);
  assert.throws(() => decryptReadableMedia(mediaCipher(plain), { ...row, sha256: '0'.repeat(64) }, keys), /SAFETY_BLOCK/);
});

test('readable keys 和 manifest 明确要求可读表示与完整范围', () => {
  assert.deepEqual(loadReadableKeys({ ENCRYPTION_KEY: key.toString('hex') }), { field: key, media: null });
  assert.deepEqual(loadReadableKeys({ ENCRYPTION_KEY: key.toString('hex'), MEDIA_ENCRYPTION_KEY: key.toString('hex') }), { field: key, media: key });
  assert.throws(() => loadReadableKeys({}), /ENCRYPTION_KEY/);
  const manifest = readableManifest({ teacherId: 'teacher_a', databaseName: 'teacher_a', account: { email: 'a@example.invalid' }, tables: [], media: [] });
  assert.equal(manifest.version, '1.2');
  assert.equal(manifest.representation, 'readable');
  assert.equal(manifest.scope, 'records_and_media');
  assert.equal(manifest.complete, true);
});
