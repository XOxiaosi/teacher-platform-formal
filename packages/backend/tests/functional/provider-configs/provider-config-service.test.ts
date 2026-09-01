import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProviderConfigService } from '../../../src/features/provider-configs/index.js';
import { decryptApiKey } from '../../../src/shared/llm-provider-compat/api-key-crypto.js';
import { providerError } from '../../../src/shared/llm-provider-compat/types.js';
import type { DnsLookup } from '../../../src/shared/ssrf/endpoint-guard.js';

const prisma = new PrismaClient();

/** 测试用 DNS：hostname 一律解析到公网 TEST-NET（避免真实网络依赖）。 */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

const service = createProviderConfigService({ prisma, dnsLookup: publicDns, allowedCidrs: [] });

// 测试用密钥（32 字节 hex）——仅测试环境；生产经 env 注入
process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'a'.repeat(64);

const createdTeacherIds: string[] = [];
const createdConfigIds: string[] = [];

function uniqueId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function createTeacher(displayName: string): Promise<string> {
  const id = uniqueId('teacher');
  await prisma.teacherRegistry.create({
    data: {
      id,
      email: `${id}@example.com`,
      passwordHash: 'scrypt:test',
      displayName,
      status: 'active',
    },
  });
  createdTeacherIds.push(id);
  return id;
}

const VALID_INPUT = {
  providerKind: 'openai',
  providerName: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test-api-key-1234',
  model: 'deepseek-chat',
};

afterAll(async () => {
  await prisma.providerConfig.deleteMany({ where: { id: { in: createdConfigIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
});

describe('provider-config 服务：apiKey 加密', () => {
  it('加密往返：encrypt → decrypt 恢复明文', async () => {
    const { encryptApiKey } = await import('../../../src/shared/llm-provider-compat/api-key-crypto.js');
    const enc = encryptApiKey('sk-roundtrip-7890');
    expect(enc).not.toContain('sk-roundtrip-7890');
    expect(decryptApiKey(enc)).toBe('sk-roundtrip-7890');
  });

  it('create：apiKeyEnc 非明文、DTO 只含 apiKeyMasked', async () => {
    const teacherId = await createTeacher('T1');
    const result = await service.create(teacherId, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.value;
    createdConfigIds.push(dto.id);

    // DTO 不含明文与密文
    expect(dto).not.toHaveProperty('apiKey');
    expect(dto).not.toHaveProperty('apiKeyEnc');
    expect(dto.apiKeyMasked).toBe('sk-****1234');

    // 库内是密文
    const row = await prisma.providerConfig.findUnique({ where: { id: dto.id } });
    expect(row?.apiKeyEnc).not.toContain('sk-test-api-key-1234');
    expect(decryptApiKey(row?.apiKeyEnc ?? '')).toBe('sk-test-api-key-1234');

    // 首条自动 isPrimary
    expect(dto.isPrimary).toBe(true);
  });
});

describe('provider-config 服务：owner 隔离', () => {
  it('跨教师不可见：A 的配置 B 查不到、删不掉、改不了', async () => {
    const teacherA = await createTeacher('ownerA');
    const teacherB = await createTeacher('ownerB');
    const created = await service.create(teacherA, VALID_INPUT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdConfigIds.push(created.value.id);

    const bList = await service.list(teacherB);
    expect(bList.ok).toBe(true);
    if (!bList.ok) return;
    expect(bList.value.find((item) => item.id === created.value.id)).toBeUndefined();

    const bUpdate = await service.update(teacherB, created.value.id, { model: 'hacked' });
    expect(bUpdate.ok).toBe(false);
    expect(bUpdate.ok || bUpdate.error.code).toBe('NOT_FOUND');

    const bDelete = await service.remove(teacherB, created.value.id);
    expect(bDelete.ok).toBe(false);
  });
});

describe('provider-config 服务：primary 唯一化', () => {
  it('设为 primary 清同教师其他 primary', async () => {
    const teacherId = await createTeacher('primaryT');
    const first = await service.create(teacherId, { ...VALID_INPUT, providerName: 'deepseek' });
    const second = await service.create(teacherId, { ...VALID_INPUT, providerName: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    createdConfigIds.push(first.value.id, second.value.id);
    expect(first.value.isPrimary).toBe(true);
    expect(second.value.isPrimary).toBe(false);

    const promoted = await service.update(teacherId, second.value.id, { isPrimary: true });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.value.isPrimary).toBe(true);

    const list = await service.list(teacherId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const primaries = list.value.filter((item) => item.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(second.value.id);
  });
});

describe('provider-config 服务：删除回退', () => {
  it('删 primary 提升最新一条；全删后无配置', async () => {
    const teacherId = await createTeacher('deleteT');
    const first = await service.create(teacherId, { ...VALID_INPUT, providerName: 'a' });
    const second = await service.create(teacherId, { ...VALID_INPUT, providerName: 'b' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    createdConfigIds.push(first.value.id, second.value.id);

    // 删除 primary（first）
    const removed = await service.remove(teacherId, first.value.id);
    expect(removed.ok).toBe(true);

    const afterDelete = await service.list(teacherId);
    expect(afterDelete.ok).toBe(true);
    if (!afterDelete.ok) return;
    expect(afterDelete.value).toHaveLength(1);
    expect(afterDelete.value[0].isPrimary).toBe(true); // second 被提升
    expect(afterDelete.value[0].id).toBe(second.value.id);

    // 全删 → 无配置（路由回退默认）
    await service.remove(teacherId, second.value.id);
    const empty = await service.list(teacherId);
    expect(empty.ok && empty.value).toHaveLength(0);
  });
});

describe('provider-config 服务：test 端点错误归一', () => {
  it('未注入探针：配置可解密即 ok', async () => {
    const teacherId = await createTeacher('probeT');
    const created = await service.create(teacherId, VALID_INPUT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdConfigIds.push(created.value.id);

    const result = await service.testConnection(teacherId, created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(true);
    expect(result.value.providerName).toBe('deepseek');
    expect(result.value.model).toBe('deepseek-chat');
  });

  it('注入探针：auth 错误映射 ProviderError kind=auth', async () => {
    const probeService = createProviderConfigService({
      prisma,
      dnsLookup: publicDns,
      allowedCidrs: [],
      chatProbe: async () => ({
        ok: false as const,
        providerError: providerError('auth', 401, 'invalid api key'),
      }),
    });
    const teacherId = await createTeacher('probeAuth');
    const created = await probeService.create(teacherId, VALID_INPUT);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdConfigIds.push(created.value.id);

    const result = await probeService.testConnection(teacherId, created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(false);
    expect(result.value.providerError?.kind).toBe('auth');
    expect(result.value.providerError?.retryable).toBe(false);
  });

  it('校验：providerKind 白名单拒绝；必填缺项拒绝', async () => {
    const teacherId = await createTeacher('validateT');
    const badKind = await service.create(teacherId, { ...VALID_INPUT, providerKind: 'gpt' });
    expect(badKind.ok).toBe(false);
    if (badKind.ok) return;
    expect(badKind.error.code).toBe('VALIDATION_ERROR');

    const missing = await service.create(teacherId, { ...VALID_INPUT, apiKey: '' });
    expect(missing.ok).toBe(false);
  });
});
