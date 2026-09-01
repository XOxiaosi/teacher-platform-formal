import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createFieldCipher,
  decryptField,
  decryptJsonField,
  encryptField,
  encryptJsonField,
  isEncryptedField,
  loadEncryptionKey,
  tryDecryptField,
  FIELD_CIPHER_PREFIX,
} from '../../../src/shared/field-encryption/index.js';
import {
  decryptApiKey,
  encryptApiKey,
} from '../../../src/shared/llm-provider-compat/api-key-crypto.js';

// 测试密钥（仅测试环境；生产经 env 注入，禁硬编码）
const TEST_HEX_KEY = 'a'.repeat(64); // 32 字节 0xAA
const TEST_BASE64_KEY = Buffer.alloc(32, 0xaa).toString('base64');
const OTHER_HEX_KEY = 'b'.repeat(64); // 不同密钥材料

describe('field-encryption：密钥加载（key-loader）', () => {
  it('ENCRYPTION_KEY 缺省 → 拒绝（SAFETY_BLOCK），不静默降级', () => {
    expect(() => loadEncryptionKey({})).toThrow(/SAFETY_BLOCK/);
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: '' })).toThrow(/SAFETY_BLOCK/);
  });

  it('密钥长度非法 → 拒绝（31 字节 hex、32 字节 hex 之外、错误 base64）', () => {
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: 'a'.repeat(62) })).toThrow(/SAFETY_BLOCK/);
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: 'z'.repeat(64) })).toThrow(/SAFETY_BLOCK/);
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: 'not-a-valid-key-value-here' })).toThrow(
      /SAFETY_BLOCK/,
    );
  });

  it('hex 64 字符与 base64 44 字符等价接受，且可互相解密', () => {
    const hexSource = loadEncryptionKey({ ENCRYPTION_KEY: TEST_HEX_KEY });
    const b64Source = loadEncryptionKey({ ENCRYPTION_KEY: TEST_BASE64_KEY });
    expect(hexSource.key.length).toBe(32);
    expect(b64Source.key.length).toBe(32);
    expect(hexSource.key.equals(b64Source.key)).toBe(true);

    const enc = encryptField('密钥格式等价', hexSource.key);
    expect(decryptField(enc, b64Source.key)).toBe('密钥格式等价');
  });

  it('ENCRYPTION_KEY_ID 透传为 keyId（轮换追踪用）', () => {
    const source = loadEncryptionKey({ ENCRYPTION_KEY: TEST_HEX_KEY, ENCRYPTION_KEY_ID: 'k-2026-01' });
    expect(source.keyId).toBe('k-2026-01');
    expect(loadEncryptionKey({ ENCRYPTION_KEY: TEST_HEX_KEY }).keyId).toBeUndefined();
  });
});

describe('field-encryption：加密往返与密文形态', () => {
  const key = Buffer.from(TEST_HEX_KEY, 'hex');

  it('加密往返：encrypt → decrypt 恢复明文（含中文/emoji/换行）', () => {
    const samples = [
      '家长反馈正文：孩子数学进步明显',
      'score: 92.5, rank: 3/28',
      'line1\nline2\ttabbed "quoted"',
      '😀 表情与符号 <script>alert(1)</script>',
      'x'.repeat(10_000), // 大字段
    ];
    for (const sample of samples) {
      const enc = encryptField(sample, key);
      expect(decryptField(enc, key)).toBe(sample);
    }
  });

  it('密文不可读明文：输出不含明文子串，且带 enc:v1 版本前缀', () => {
    const plain = 'sk-机密-abc-123456';
    const enc = encryptField(plain, key);
    expect(enc).not.toContain(plain);
    expect(enc).not.toContain('机密');
    expect(enc.startsWith(`${FIELD_CIPHER_PREFIX}:`)).toBe(true);
    expect(enc.split(':').length).toBe(5); // enc:v1:iv:tag:cipher
  });

  it('同一明文两次加密产出不同密文（随机 IV）', () => {
    const a = encryptField('相同明文', key);
    const b = encryptField('相同明文', key);
    expect(a).not.toBe(b);
    expect(decryptField(a, key)).toBe(decryptField(b, key));
  });

  it('空串直通：encrypt(\'\') = \'\'，decrypt(\'\') = \'\'（与 api-key-crypto 一致）', () => {
    expect(encryptField('', key)).toBe('');
    expect(decryptField('', key)).toBe('');
  });

  it('isEncryptedField：识别 enc:v1 与 legacy v1，拒绝明文', () => {
    expect(isEncryptedField(encryptField('x', key))).toBe(true);
    expect(isEncryptedField('v1:YWJj:ZGVm:Z2hp')).toBe(true);
    expect(isEncryptedField('普通明文内容')).toBe(false);
    expect(isEncryptedField('')).toBe(false);
  });

  it('密钥错误 / 密文被篡改 → 解密抛 SAFETY_BLOCK（GCM 认证失败）', () => {
    const enc = encryptField('机密内容', key);
    const wrongKey = Buffer.from(OTHER_HEX_KEY, 'hex');
    expect(() => decryptField(enc, wrongKey)).toThrow(/SAFETY_BLOCK/);

    const parts = enc.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    expect(() => decryptField(parts.join(':'), key)).toThrow(/SAFETY_BLOCK/);

    // 未知前缀 → 拒绝而非静默直通
    expect(() => decryptField('zz:abc:def:ghi:jkl', key)).toThrow(/SAFETY_BLOCK/);
  });

  it('tryDecryptField：明文旧行直通（迁移双读窗口），密文正常解密', () => {
    expect(tryDecryptField('2024-01-01 旧明文行', key)).toBe('2024-01-01 旧明文行');
    expect(tryDecryptField('', key)).toBe('');
    const enc = encryptField('新密文', key);
    expect(tryDecryptField(enc, key)).toBe('新密文');
  });

  it('createFieldCipher 工厂：闭包注入密钥的实例化 API 全通', () => {
    const cipher = createFieldCipher(key);
    const enc = cipher.encrypt('工厂实例');
    expect(cipher.decrypt(enc)).toBe('工厂实例');
    expect(cipher.isEncrypted(enc)).toBe(true);
    expect(cipher.tryDecrypt('旧明文')).toBe('旧明文');

    const jsonEnc = cipher.encryptJson({ a: 1, list: ['x', 'y'] });
    expect(cipher.decryptJson<{ a: number; list: string[] }>(jsonEnc)).toEqual({
      a: 1,
      list: ['x', 'y'],
    });
  });
});

describe('field-encryption：Json 字段整体加密', () => {
  const key = Buffer.from(TEST_HEX_KEY, 'hex');

  it('对象/数组/嵌套 Json 往返一致', () => {
    const values = [
      { parentConcerns: ['注意力不集中', '作业拖拉'], followUps: ['两周后复查'] },
      ['a', 'b', { deep: true }],
      { before: { amount: 3000 }, after: { amount: 2800 }, diff: ['amount'] },
      {},
    ];
    for (const value of values) {
      const enc = encryptJsonField(value, key);
      expect(enc).not.toContain('注意力不集中');
      expect(decryptJsonField(enc, key)).toEqual(value);
    }
  });

  it('Json 密文带 enc:v1 前缀且不含任何字段明文', () => {
    const enc = encryptJsonField({ score: 92.5, name: '张三' }, key);
    expect(enc.startsWith(`${FIELD_CIPHER_PREFIX}:`)).toBe(true);
    expect(enc).not.toContain('92.5');
    expect(enc).not.toContain('张三');
  });
});

describe('field-encryption：与 api-key-crypto（legacy v1 格式）兼容', () => {
  const key = Buffer.from(TEST_HEX_KEY, 'hex');

  afterAll(() => {
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  });

  it('旧格式读取兼容：api-key-crypto 产出 → decryptField/tryDecryptField 可解', () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_HEX_KEY; // 同一密钥材料
    const legacy = encryptApiKey('sk-legacy-api-key-998877');
    expect(legacy.startsWith('v1:')).toBe(true);
    expect(legacy.split(':').length).toBe(4); // v1:iv:cipher:tag

    // 新模块自动识别 legacy 前缀并解密（迁移双读的关键）
    expect(decryptField(legacy, key)).toBe('sk-legacy-api-key-998877');
    expect(tryDecryptField(legacy, key)).toBe('sk-legacy-api-key-998877');
    expect(isEncryptedField(legacy)).toBe(true);
  });

  it('新格式与旧模块解耦：新密文用相同密钥材料、legacy 解密器不可读（单向兼容，文档化）', () => {
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_HEX_KEY;
    const enc = encryptField('新字段密文', key);
    expect(enc.startsWith(`${FIELD_CIPHER_PREFIX}:`)).toBe(true);
    // legacy 解密器只认 v1 前缀 → 对新格式抛错（预期，新字段全部走新模块）
    expect(() => decryptApiKey(enc)).toThrow();
  });

  it('轮换场景：同密钥材料下，hex 编码与 base64 编码互解（运维可换编码不换材料）', () => {
    const encHex = encryptField('轮换编码测试', key);
    const b64Key = Buffer.from(TEST_BASE64_KEY, 'base64');
    expect(decryptField(encHex, b64Key)).toBe('轮换编码测试');
  });

  it('随机密钥抽样验证：随机生成密钥往返稳定', () => {
    const randomKey = randomBytes(32);
    const plain = `random-${randomBytes(8).toString('hex')}`;
    expect(decryptField(encryptField(plain, randomKey), randomKey)).toBe(plain);
  });
});
