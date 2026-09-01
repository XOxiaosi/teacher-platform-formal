/**
 * Provider apiKey 加密（P7 渠道线 · t63，t57 设计 §2.1）。
 *
 * 应用层 AES-256-GCM：apiKey 加密后落 ProviderConfig.apiKeyEnc，任何响应/日志
 * 只回 apiKeyMasked（sk-****last4），不回明文。
 *
 * 密钥来源：PROVIDER_KEY_ENCRYPTION_KEY env（32 字节 hex，即 64 hex 字符）。
 * - 缺省 → 禁用加密的明确错误（拒绝明文落库，安全红线）；
 * - 本波为简单应用层实现（AES-256-GCM + 随机 12 字节 IV），正式 KMS/保险库
 *   集成属 t36 阶段三（注释标注交接点）。
 *
 * 密文格式：`v1:<iv b64>:<ciphertext b64>`（AAD=空；GCM 自带完整性）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const KEY_ENV = 'PROVIDER_KEY_ENCRYPTION_KEY';
const VERSION_PREFIX = 'v1';
const IV_BYTES = 12;

function loadKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env[KEY_ENV];
  if (!hex) {
    throw new Error(`SAFETY_BLOCK: 缺少 ${KEY_ENV}（32 字节 hex）——拒绝明文落库`);
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`SAFETY_BLOCK: ${KEY_ENV} 必须是 32 字节（64 hex 字符），当前 ${key.length} 字节`);
  }
  return key;
}

export function encryptApiKey(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!plain) return plain;
  const key = loadKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_PREFIX}:${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptApiKey(encrypted: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!encrypted) return encrypted;
  const key = loadKey(env);
  const parts = encrypted.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error('SAFETY_BLOCK: apiKey 密文格式无效');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const data = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** 掩码：sk-****last4（不回明文；短密钥全掩）。 */
export function maskApiKey(plainOrEncrypted: string): string {
  if (!plainOrEncrypted) return '';
  if (plainOrEncrypted.length <= 8) return '****';
  const tail = plainOrEncrypted.slice(-4);
  return `sk-****${tail}`;
}
