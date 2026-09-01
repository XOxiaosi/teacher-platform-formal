/**
 * 字段加密密钥加载（P8 phase-3 加密落位 · t1）。
 *
 * 密钥来源：`ENCRYPTION_KEY` 环境变量（32 字节，二选一编码）：
 *   - hex：64 个十六进制字符（与 api-key-crypto 的 PROVIDER_KEY_ENCRYPTION_KEY 同款，
 *     可直接复用同一密钥材料，便于 api-key-crypto 迁移到本模块）；
 *   - base64：44 字符（32 字节的 base64 标准编码）。
 * 两者解码后必须恰好 32 字节，否则拒绝（SAFETY_BLOCK）。
 *
 * 版本标识：`ENCRYPTION_KEY_ID` 可选；密文带 `enc:v1` 版本前缀，轮换 = 新版本写新、
 * 旧版本可读（双读窗口），见设计文档 p7-field-encryption-module-design.md。
 *
 * 安全红线（与 api-key-crypto 一致）：
 *   - 缺省 → 明确错误，拒绝明文落库 / 拒绝解密；
 *   - 禁硬编码：任何代码路径不得内嵌密钥，必须经 env / 保险库 / KMS 注入。
 */

import { randomBytes } from 'node:crypto';

export const FIELD_ENCRYPTION_KEY_ENV = 'ENCRYPTION_KEY';
export const FIELD_ENCRYPTION_KEY_ID_ENV = 'ENCRYPTION_KEY_ID';
export const KEY_BYTES = 32;

export interface EncryptionKeySource {
  /** 32 字节 AES-256 密钥材料。 */
  key: Buffer;
  /** 密钥版本标识（来自 ENCRYPTION_KEY_ID，可选，用于轮换追踪）。 */
  keyId?: string;
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
  return decoded.length === KEY_BYTES ? decoded : null;
}

/**
 * 从 env 加载字段加密密钥。缺省或长度非法 → 抛 SAFETY_BLOCK（拒绝明文落库红线）。
 * @param env 环境变量来源（默认 process.env；测试可注入）
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): EncryptionKeySource {
  const raw = env[FIELD_ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(
      `SAFETY_BLOCK: 缺少 ${FIELD_ENCRYPTION_KEY_ENV}（32 字节，hex 64 字符或 base64 44 字符）——拒绝明文落库`,
    );
  }
  const key = decodeHexKey(raw) ?? decodeBase64Key(raw);
  if (!key) {
    throw new Error(
      `SAFETY_BLOCK: ${FIELD_ENCRYPTION_KEY_ENV} 必须是 32 字节（64 hex 字符或 base64 44 字符），当前值非法`,
    );
  }
  const keyId = env[FIELD_ENCRYPTION_KEY_ID_ENV] || undefined;
  return { key, keyId };
}

/**
 * 生成新密钥（运维轮换用）：返回 32 字节 base64。禁止用于生产硬编码；
 * 仅供轮换脚本 / 初始部署生成后写入保险库 / KMS。
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
