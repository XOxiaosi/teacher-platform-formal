/** P6-READABLE: strict, fail-closed conversion of stored export rows. */
import { createDecipheriv } from 'node:crypto';
import { createHash } from 'node:crypto';

export const FIELD_CIPHER_PREFIX = 'enc:v1';
export const LEGACY_CIPHER_PREFIX = 'v1';
export const MEDIA_MAGIC = Buffer.from('TPMEDENC', 'ascii');
export const MEDIA_HEADER_BYTES = 37;

// These lists are deliberately explicit. A newly encrypted field must be added
// here before it can enter a readable export; silently passing it through would
// turn a stored-encoding value into a misleading readable value.
export const READABLE_TEXT_FIELDS = Object.freeze({
  AINote: ['rawInput'], CaptureEvent: ['rawText'], ConversationTurn: ['content'], AgentExecution: ['reply'],
  PendingAction: ['beforeSummary', 'afterSummary'], Payment: ['note'], LessonLedgerEntry: ['reasonCiphertext'],
  LessonLedgerAdjustmentConfirmation: ['reasonCiphertext'], Memo: ['content'], PushRecord: ['content'],
  ParentFeedback: ['title', 'content', 'parentName'], FeedbackEvidence: ['summary'], StudentSourceRecord: ['rawText'], StudentRecord: ['summary'],
  AssessmentDetail: ['note'], TaskRuntime: ['title'], Lesson: ['progress', 'studentState', 'homework', 'teacherNote'],
  Schedule: ['locationCiphertext', 'operationalNoteCiphertext'], RecurrenceRule: ['locationCiphertext', 'operationalNoteCiphertext'],
});

export const READABLE_JSON_FIELDS = Object.freeze({
  AINote: ['extractedData'], CaptureCandidate: ['payload', 'originalPayload'], ConversationTurn: ['toolCalls', 'toolResults'],
  AgentExecution: ['error'], PendingAction: ['parameters'], ChangeLog: ['before', 'after', 'diff'],
  CommunicationDetail: ['parentConcerns', 'teacherResponses', 'agreements', 'followUps'], StudentRecord: ['structuredData'],
  FeedbackEvidence: ['parentConcerns', 'followUps'], TaskRuntime: ['dshCheckpoint', 'lastError'], StepReceipt: ['resultRef', 'error'],
  ScheduleRevision: ['beforeCiphertext', 'afterCiphertext'], WebMutationReceipt: ['ciphertext'],
  ParentFeedback: ['creationReceiptCiphertext'],
});

function safety(message) { throw new Error(`SAFETY_BLOCK: ${message}`); }

function decodeKey(raw, label) {
  if (typeof raw !== 'string' || raw.length === 0) safety(`缺少 ${label}`);
  let value;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) value = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(raw) || /^[A-Za-z0-9+/]{44}$/.test(raw)) value = Buffer.from(raw, 'base64');
  else safety(`${label} 格式无效`);
  if (value.length !== 32) safety(`${label} 必须是 32 字节`);
  return value;
}

export function loadReadableKeys(env = process.env) {
  return {
    field: decodeKey(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY'),
    media: env.MEDIA_ENCRYPTION_KEY ? decodeKey(env.MEDIA_ENCRYPTION_KEY, 'MEDIA_ENCRYPTION_KEY') : null,
  };
}

function strictBase64(value, label) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) safety(`${label} 编码无效`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) safety(`${label} 编码无效`);
  return decoded;
}

function decryptFieldCiphertext(value, key) {
  if (typeof value !== 'string' || !value) safety('字段密文不能为空');
  const parts = value.split(':');
  let iv; let tag; let ciphertext;
  if (parts[0] === 'enc' && parts[1] === 'v1' && parts.length === 5) {
    iv = strictBase64(parts[2], 'iv'); tag = strictBase64(parts[3], 'tag'); ciphertext = strictBase64(parts[4], 'cipher');
  } else if (parts[0] === LEGACY_CIPHER_PREFIX && parts.length === 4) {
    iv = strictBase64(parts[1], 'iv'); ciphertext = strictBase64(parts[2], 'cipher'); tag = strictBase64(parts[3], 'tag');
  } else safety('未知或损坏的字段密文格式');
  if (iv.length !== 12 || tag.length !== 16) safety('字段密文头长度无效');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch { safety('字段密文解密失败'); }
}

export function decryptReadableText(value, key) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') safety('可读文本字段类型无效');
  if (!value.startsWith(`${FIELD_CIPHER_PREFIX}:`) && !value.startsWith(`${LEGACY_CIPHER_PREFIX}:`)) {
    // Empty values are valid nullable encrypted columns. Non-empty plaintext
    // is a legacy row and is preserved for the migration double-read window.
    return value;
  }
  return decryptFieldCiphertext(value, key);
}

export function decryptReadableJson(value, key) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const plain = value.startsWith(`${FIELD_CIPHER_PREFIX}:`) || value.startsWith(`${LEGACY_CIPHER_PREFIX}:`)
    ? decryptFieldCiphertext(value, key)
    : value;
  try { return JSON.parse(plain); } catch { safety('可读 JSON 字段无法解析'); }
}

export function readableRow(model, row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) safety('导出行结构无效');
  const result = { ...row };
  for (const field of READABLE_TEXT_FIELDS[model] ?? []) result[field] = decryptReadableText(result[field], keys.field);
  for (const field of READABLE_JSON_FIELDS[model] ?? []) result[field] = decryptReadableJson(result[field], keys.field);
  return result;
}

function mediaDecrypt(data, key) {
  if (!Buffer.isBuffer(data)) safety('媒体内容类型无效');
  if (data.length === 0) return data;
  if (!data.subarray(0, MEDIA_MAGIC.length).equals(MEDIA_MAGIC)) return data;
  if (!key) safety('缺少 MEDIA_ENCRYPTION_KEY');
  if (data.length < MEDIA_HEADER_BYTES) safety('媒体密文头不完整');
  if (data[8] !== 1) safety('不支持的媒体加密版本');
  const iv = data.subarray(9, 21); const tag = data.subarray(21, 37); const ciphertext = data.subarray(37);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { safety('媒体文件解密失败'); }
}

export function decryptReadableMedia(data, row, keys) {
  if (!row || typeof row !== 'object') safety('媒体元数据无效');
  const encrypted = data.subarray(0, MEDIA_MAGIC.length).equals(MEDIA_MAGIC);
  if (!encrypted && row.encryptionVersion !== null && row.encryptionVersion !== undefined) {
    safety('媒体加密版本与原件格式不一致');
  }
  const plain = mediaDecrypt(data, keys.media);
  const digest = createHash('sha256').update(plain).digest('hex');
  if (digest !== row.sha256 || plain.length !== Number(row.sizeBytes)) safety('媒体 sha256 或大小校验失败');
  return plain;
}

export function readableManifest({ teacherId, account, databaseName, tables, media, exportedAt = new Date().toISOString() }) {
  return {
    version: '1.2', exportedAt, teacherId, email: account?.email ?? null, databaseName,
    representation: 'readable', scope: 'records_and_media', complete: true,
    note: '教师业务记录和媒体原件已严格校验并解密；认证资料、凭据、claim/lease token 已排除。',
    tables, media,
  };
}
