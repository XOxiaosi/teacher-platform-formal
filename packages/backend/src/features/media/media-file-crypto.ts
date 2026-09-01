/**
 * 媒体文件加密模块（P9 S3 阶段二 · t3，设计 p7-media-evidence-design.md §7.3）。
 *
 * 存储轨文件级 AES-256-GCM 加密：整文件加密后落盘，落盘内容为密文
 * （备份 dump/媒体副本均为密文——与字段加密的备份红利一致）。
 *
 * 密钥独立 env：`MEDIA_ENCRYPTION_KEY`（32 字节，hex 64 字符或 base64 44 字符），
 * 与字段加密 `ENCRYPTION_KEY` 分轨（设计 §10-4 推荐独立，降低单密钥泄露面）。
 * 禁硬编码：任何代码路径不得内嵌密钥；缺省/非法 → SAFETY_BLOCK 拒绝写明文。
 *
 * 落盘文件格式（二进制头 + 密文，避免 base64 膨胀）：
 *   [0..8)  魔数 'TPMEDENC'（8 字节 ASCII，版本/轮换识别）
 *   [8]     版本字节 0x01
 *   [9..21) IV 12 字节（GCM 推荐 nonce 长度，随机）
 *   [21..37) GCM authTag 16 字节（完整性 + 认证）
 *   [37..)  密文（明文等长 + 16 字节 GCM 开销）
 *
 * 读路径：命中魔数 → 解密；无魔数 → 阶段一明文遗留直通（迁移双读窗口，不改写旧文件）。
 * 解密失败（魔数损坏/认证失败/密钥错误）一律抛 SAFETY_BLOCK，不回退、不静默降级。
 */

import { createCipheriv, createDecipheriv, randomBytes, type CipherKey } from 'node:crypto';

export const MEDIA_ENCRYPTION_KEY_ENV = 'MEDIA_ENCRYPTION_KEY';
export const MEDIA_ENCRYPTION_VERSION = 'aes-256-gcm';
export const MEDIA_ENC_MAGIC = Buffer.from('TPMEDENC', 'ascii');
export const MEDIA_ENC_VERSION_BYTE = 0x01;
export const MEDIA_ENC_IV_BYTES = 12;
export const MEDIA_ENC_TAG_BYTES = 16;
/** 头总长：魔数 8 + 版本 1 + IV 12 + tag 16 = 37。 */
export const MEDIA_ENC_HEADER_BYTES = 8 + 1 + MEDIA_ENC_IV_BYTES + MEDIA_ENC_TAG_BYTES;
export const MEDIA_KEY_BYTES = 32;

export type MediaFileCipherKey = CipherKey;

export interface MediaFileCipher {
  /** 加密：返回带头的密文 Buffer；空输入返回空（约定与字段加密一致）。 */
  encrypt(plaintext: Buffer): Buffer;
  /** 解密：自动识别密文头；明文（无头）原样返回（阶段一遗留双读）。 */
  decrypt(data: Buffer): Buffer;
  /** 判断是否为带媒体加密头的密文。 */
  isEncrypted(data: Buffer): boolean;
  /** 版本标识（写入 DB encryptionVersion）。 */
  readonly version: string;
}

function assertKey(key: MediaFileCipherKey): Buffer {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key as string);
  if (buf.length !== MEDIA_KEY_BYTES) {
    throw new Error(
      `SAFETY_BLOCK: MEDIA_ENCRYPTION_KEY 必须是 32 字节，当前 ${buf.length} 字节`,
    );
  }
  return buf;
}

function decodeHexKey(value: string): Buffer | null {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return Buffer.from(value, 'hex');
}

function decodeBase64Key(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed) && !/^[A-Za-z0-9+/]{44}$/.test(trimmed)) {
    return null;
  }
  const decoded = Buffer.from(trimmed, 'base64');
  return decoded.length === MEDIA_KEY_BYTES ? decoded : null;
}

/**
 * 从 env 加载媒体加密密钥。缺省或长度非法 → 抛 SAFETY_BLOCK（拒绝明文落盘红线）。
 * @param env 环境变量来源（默认 process.env；测试可注入）
 */
export function loadMediaEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[MEDIA_ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(
      `SAFETY_BLOCK: 缺少 ${MEDIA_ENCRYPTION_KEY_ENV}（32 字节，hex 64 字符或 base64 44 字符）——拒绝媒体明文落盘`,
    );
  }
  const key = decodeHexKey(raw) ?? decodeBase64Key(raw);
  if (!key) {
    throw new Error(
      `SAFETY_BLOCK: ${MEDIA_ENCRYPTION_KEY_ENV} 必须是 32 字节（64 hex 字符或 base64 44 字符），当前值非法`,
    );
  }
  return key;
}

/** 从 env 构建 cipher；缺 env → undefined（装配期惰性；写路径 SAFETY_BLOCK 拒绝明文落盘）。 */
export function createMediaFileCipherFromEnv(env: NodeJS.ProcessEnv = process.env): MediaFileCipher | undefined {
  const raw = env[MEDIA_ENCRYPTION_KEY_ENV];
  if (raw === undefined || raw === '') return undefined;
  return createMediaFileCipher(loadMediaEncryptionKey(env));
}

/** 判断 Buffer 是否带媒体加密头。 */
export function isMediaEncryptedFile(data: Buffer): boolean {
  return data.length >= MEDIA_ENC_HEADER_BYTES && data.subarray(0, MEDIA_ENC_MAGIC.length).equals(MEDIA_ENC_MAGIC);
}

/** 加密整文件：头（魔数+版本+iv+tag）+ 密文。 */
export function encryptMediaFile(plaintext: Buffer, key: MediaFileCipherKey): Buffer {
  if (plaintext.length === 0) return plaintext;
  const keyBuf = assertKey(key);
  const iv = randomBytes(MEDIA_ENC_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MEDIA_ENC_MAGIC,
    Buffer.from([MEDIA_ENC_VERSION_BYTE]),
    iv,
    tag,
    encrypted,
  ]);
}

/** 解密：验证头 → GCM 解密；无头（阶段一明文遗留）原样返回；认证失败/格式非法抛 SAFETY_BLOCK。 */
export function decryptMediaFile(data: Buffer, key: MediaFileCipherKey): Buffer {
  if (data.length === 0) return data;
  if (!isMediaEncryptedFile(data)) return data; // 阶段一明文遗留双读
  const keyBuf = assertKey(key);
  const version = data[MEDIA_ENC_MAGIC.length];
  if (version !== MEDIA_ENC_VERSION_BYTE) {
    throw new Error(`SAFETY_BLOCK: 不支持的媒体文件加密版本 0x${version.toString(16)}`);
  }
  const iv = data.subarray(MEDIA_ENC_MAGIC.length + 1, MEDIA_ENC_MAGIC.length + 1 + MEDIA_ENC_IV_BYTES);
  const tag = data.subarray(
    MEDIA_ENC_MAGIC.length + 1 + MEDIA_ENC_IV_BYTES,
    MEDIA_ENC_HEADER_BYTES,
  );
  const ciphertext = data.subarray(MEDIA_ENC_HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM 认证失败（密钥错误 / 密文被篡改）——统一安全错误，不泄露细节。
    throw new Error('SAFETY_BLOCK: 媒体文件解密失败（认证失败或密钥不匹配）');
  }
}

/** 工厂：闭包注入密钥，返回实例化 cipher（服务层依赖注入用，测试可注入假实现）。 */
export function createMediaFileCipher(key: MediaFileCipherKey): MediaFileCipher {
  const keyBuf = assertKey(key);
  return {
    encrypt: (plaintext) => encryptMediaFile(plaintext, keyBuf),
    decrypt: (data) => decryptMediaFile(data, keyBuf),
    isEncrypted: (data) => isMediaEncryptedFile(data),
    version: MEDIA_ENCRYPTION_VERSION,
  };
}
