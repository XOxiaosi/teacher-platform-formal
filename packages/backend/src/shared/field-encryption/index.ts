/**
 * 字段加密模块统一出口（P8 phase-3 加密落位 · t1）。
 *
 * 用法：
 *   const { key } = loadEncryptionKey();                 // env 注入，缺省抛 SAFETY_BLOCK
 *   const cipher = createFieldCipher(key);               // 或直接 encryptField/decryptField
 *   const enc = cipher.encrypt('敏感内容');               // enc:v1:<iv>:<tag>:<cipher>
 *   cipher.decrypt(enc);                                  // 恢复明文
 *   cipher.tryDecrypt(row.field);                         // 明文旧行直通（迁移双读）
 */

export {
  createFieldCipher,
  createFieldCipherFromEnv,
  decryptField,
  decryptFieldValue,
  decryptJsonField,
  decryptJsonFieldValue,
  encryptField,
  encryptFieldValue,
  encryptJsonField,
  encryptJsonFieldValue,
  isEncryptedField,
  tryDecryptField,
  FIELD_CIPHER_PREFIX,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  LEGACY_CIPHER_PREFIX,
  IV_BYTES,
  TAG_BYTES,
} from './field-cipher.js';
export type { FieldCipher, FieldCipherKey } from './field-cipher.js';

export {
  FIELD_ENCRYPTION_KEY_ENV,
  FIELD_ENCRYPTION_KEY_ID_ENV,
  KEY_BYTES,
  generateEncryptionKey,
  loadEncryptionKey,
} from './key-loader.js';
export type { EncryptionKeySource } from './key-loader.js';
