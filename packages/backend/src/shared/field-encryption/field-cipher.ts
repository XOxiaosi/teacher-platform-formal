/**
 * 字段加密核心（P8 phase-3 加密落位 · t1）。
 *
 * 统一 AES-256-GCM 字段加密模块（应用层字段加密，方案依据
 * reports/architecture/p7-encryption-assessment.md §4.1/§4.3）。
 *
 * 密文格式（新字段统一）：
 *   `enc:v1:<ivB64>:<tagB64>:<cipherB64>`
 *     - 前缀 `enc:v1` = 版本标识（轮换/迁移识别）；
 *     - iv = 随机 12 字节（GCM 推荐 nonce 长度），base64；
 *     - tag = GCM authTag 16 字节（完整性 + 认证），base64；
 *     - cipher = 密文，base64；AAD = 空（GCM 自带完整性）。
 *
 * 兼容读取（legacy，不改写现有数据）：
 *   `v1:<ivB64>:<cipherB64>:<tagB64>` —— 即 api-key-crypto（t63）现有格式，
 *   decryptField / tryDecryptField 自动识别读取，保证已落库的
 *   ProviderConfig.apiKeyEnc 在迁移期仍可解密（双读窗口）。
 *
 * 约定：
 *   - 空字符串直通（encrypt('') = ''，decrypt('') = ''），与 api-key-crypto 一致；
 *     null/undefined 由调用方（服务层）处理，本模块只接受 string；
 *   - 密钥必须由调用方显式注入（Buffer 或 loadEncryptionKey 产物），禁全局默认；
 *   - 解密失败（格式非法 / 认证失败 / 密钥错误）一律抛错，不回退明文。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherKey,
} from 'node:crypto';
import {
  FIELD_ENCRYPTION_KEY_ENV,
  loadEncryptionKey,
} from './key-loader.js';

export const FIELD_CIPHER_PREFIX = 'enc:v1';
export const LEGACY_CIPHER_PREFIX = 'v1';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE =
  'SAFETY_BLOCK: 缺少 ENCRYPTION_KEY——拒绝明文落库';

export type FieldCipherKey = CipherKey;

export interface FieldCipher {
  /** 加密：返回 `enc:v1:...` 密文；空串直通。 */
  encrypt(plaintext: string): string;
  /** 解密：自动识别 enc:v1 / legacy v1；格式非法或认证失败抛错。 */
  decrypt(encrypted: string): string;
  /** 解密或直通：非加密值（明文旧行）原样返回，供迁移双读窗口使用。 */
  tryDecrypt(encrypted: string): string;
  /** 判断值是否为已知前缀的密文。 */
  isEncrypted(value: string): boolean;
  /** JSON 序列化后整体加密（Json 字段用）。 */
  encryptJson(value: unknown): string;
  /** 解密后 JSON 反序列化（Json 字段用）。 */
  decryptJson<T = unknown>(encrypted: string): T;
}

function assertKey(key: FieldCipherKey): Buffer {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key as string);
  if (buf.length !== 32) {
    throw new Error(`SAFETY_BLOCK: 字段加密密钥必须是 32 字节，当前 ${buf.length} 字节`);
  }
  return buf;
}

/** 新格式编码：enc:v1:<iv>:<tag>:<cipher>。 */
export function encryptField(plaintext: string, key: FieldCipherKey): string {
  if (!plaintext) return plaintext;
  const keyBuf = assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FIELD_CIPHER_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** 新格式解码：enc:v1:<iv>:<tag>:<cipher>（rest = [iv, tag, cipher]）。 */
function decryptEncV1(rest: string[], key: Buffer): string {
  if (rest.length !== 3) {
    throw new Error('SAFETY_BLOCK: 字段密文格式无效（enc:v1:iv:tag:cipher）');
  }
  const iv = Buffer.from(rest[0], 'base64');
  const tag = Buffer.from(rest[1], 'base64');
  const data = Buffer.from(rest[2], 'base64');
  return gcmDecrypt(key, iv, tag, data);
}

/** 旧格式解码：v1:<iv>:<cipher>:<tag>（api-key-crypto 兼容读取，rest = [iv, cipher, tag]）。 */
function decryptLegacyV1(rest: string[], key: Buffer): string {
  if (rest.length !== 3) {
    throw new Error('SAFETY_BLOCK: 字段密文格式无效（v1:iv:cipher:tag）');
  }
  const iv = Buffer.from(rest[0], 'base64');
  const data = Buffer.from(rest[1], 'base64');
  const tag = Buffer.from(rest[2], 'base64');
  return gcmDecrypt(key, iv, tag, data);
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败（密钥错误 / 密文被篡改）——统一安全错误，不泄露细节。
    throw new Error('SAFETY_BLOCK: 字段密文解密失败（认证失败或密钥不匹配）');
  }
}

/** 解密：自动识别 enc:v1（新）/ v1（legacy）；空串直通。 */
export function decryptField(encrypted: string, key: FieldCipherKey): string {
  if (!encrypted) return encrypted;
  const keyBuf = assertKey(key);
  if (encrypted.startsWith(`${FIELD_CIPHER_PREFIX}:`)) {
    return decryptEncV1(encrypted.slice(FIELD_CIPHER_PREFIX.length + 1).split(':'), keyBuf);
  }
  if (encrypted.startsWith(`${LEGACY_CIPHER_PREFIX}:`)) {
    return decryptLegacyV1(encrypted.slice(LEGACY_CIPHER_PREFIX.length + 1).split(':'), keyBuf);
  }
  throw new Error('SAFETY_BLOCK: 未知的字段密文格式（缺少 enc:v1 / v1 前缀）');
}

/** 解密或直通：未知前缀（明文旧行 / 非密文）原样返回，供迁移双读窗口使用。 */
export function tryDecryptField(encrypted: string, key: FieldCipherKey): string {
  if (!encrypted) return encrypted;
  const keyBuf = assertKey(key);
  if (encrypted.startsWith(`${FIELD_CIPHER_PREFIX}:`)) {
    return decryptEncV1(encrypted.slice(FIELD_CIPHER_PREFIX.length + 1).split(':'), keyBuf);
  }
  if (encrypted.startsWith(`${LEGACY_CIPHER_PREFIX}:`)) {
    return decryptLegacyV1(encrypted.slice(LEGACY_CIPHER_PREFIX.length + 1).split(':'), keyBuf);
  }
  return encrypted;
}

/** 判断值是否为已知前缀的密文（enc:v1 或 legacy v1）。 */
export function isEncryptedField(value: string): boolean {
  return value.startsWith(`${FIELD_CIPHER_PREFIX}:`) || value.startsWith(`${LEGACY_CIPHER_PREFIX}:`);
}

/** JSON 序列化后整体加密（Json 字段：parentConcerns、structuredData、before/after 等）。 */
export function encryptJsonField(value: unknown, key: FieldCipherKey): string {
  return encryptField(JSON.stringify(value), key);
}

/** 解密后 JSON 反序列化。 */
export function decryptJsonField<T = unknown>(encrypted: string, key: FieldCipherKey): T {
  const plain = decryptField(encrypted, key);
  return JSON.parse(plain) as T;
}

/** 工厂：闭包注入密钥，返回实例化 cipher（服务层依赖注入用，测试可注入假实现）。 */
export function createFieldCipher(key: FieldCipherKey): FieldCipher {
  const keyBuf = assertKey(key);
  return {
    encrypt: (plaintext) => encryptField(plaintext, keyBuf),
    decrypt: (encrypted) => decryptField(encrypted, keyBuf),
    tryDecrypt: (encrypted) => tryDecryptField(encrypted, keyBuf),
    isEncrypted: (value) => isEncryptedField(value),
    encryptJson: (value) => encryptJsonField(value, keyBuf),
    decryptJson: (encrypted) => decryptJsonField(encrypted, keyBuf),
  };
}

/**
 * 服务层便捷工厂：从 env 构建 cipher。
 * - ENCRYPTION_KEY 未配置 → 返回 undefined（惰性：写路径 SAFETY_BLOCK 拒绝明文落库，读路径明文旧行直通）；
 * - 已配置但非法 → 立即抛（配置错误 fail-fast）。
 */
export function createFieldCipherFromEnv(env: NodeJS.ProcessEnv = process.env): FieldCipher | undefined {
  const raw = env[FIELD_ENCRYPTION_KEY_ENV];
  if (raw === undefined || raw === '') return undefined;
  return createFieldCipher(loadEncryptionKey(env).key);
}

/**
 * 读路径解密 helper（服务层统一用）：
 * - cipher 未配置：明文旧行直通（双读窗口）；密文无法解密 → SAFETY_BLOCK（不泄露密文到响应）；
 * - cipher 已配置：tryDecrypt（明文旧行直通 / 密文解密）。
 */
export function decryptFieldValue(cipher: FieldCipher | undefined, value: string): string {
  if (!cipher) {
    if (isEncryptedField(value)) {
      throw new Error('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY 无法解密已加密字段');
    }
    return value;
  }
  return cipher.tryDecrypt(value);
}

/** 写路径加密 helper（服务层统一用）：cipher 未配置 → SAFETY_BLOCK 拒绝明文落库。 */
export function encryptFieldValue(cipher: FieldCipher | undefined, value: string): string {
  if (!cipher) {
    throw new Error(FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE);
  }
  return cipher.encrypt(value);
}

/**
 * Json 字段读路径 helper（jsonb 列）：
 * - 值非字符串（jsonb 数组/对象/null，旧明文）→ 原样返回；
 * - 密文字符串 → 解密 + JSON.parse；
 * - 非加密字符串（如手工写入的 JSON 字符串）→ 尝试 parse，失败原样返回。
 * cipher 未配置且值为密文 → SAFETY_BLOCK。
 */
export function decryptJsonFieldValue(cipher: FieldCipher | undefined, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (cipher && cipher.isEncrypted(value)) return cipher.decryptJson(value);
  if (!cipher && isEncryptedField(value)) {
    throw new Error('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY 无法解密已加密字段');
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Json 字段写路径 helper：cipher 未配置 → SAFETY_BLOCK 拒绝明文落库。 */
export function encryptJsonFieldValue(cipher: FieldCipher | undefined, value: unknown): string {
  if (!cipher) {
    throw new Error(FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE);
  }
  return cipher.encryptJson(value);
}
