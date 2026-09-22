import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProviderConfigService } from '../../../src/features/provider-configs/index.js';
import type { DnsLookup } from '../../../src/shared/ssrf/endpoint-guard.js';

const prisma = new PrismaClient();

// 测试用密钥（32 字节 hex）——仅测试环境；生产经 env 注入
process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'c'.repeat(64);

/** 测试用 DNS：hostname 一律解析到公网 TEST-NET。 */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

const service = createProviderConfigService({ prisma, dnsLookup: publicDns, allowedCidrs: [] });

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

afterAll(async () => {
  await prisma.providerConfig.deleteMany({ where: { id: { in: createdConfigIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
});

describe('provider-config 服务：SSRF baseUrl 校验（契约 §3 L1）', () => {
  it('本机安全静态模式：保存 hostname 不做 DNS，仍拒绝保留地址', async () => {
    const teacherId = await createTeacher('staticOnly');
    const dnsLookup = vi.fn(async () => {
      throw new Error('static mode must not resolve DNS');
    });
    const staticService = createProviderConfigService({
      prisma,
      allowedCidrs: [],
      dnsLookup,
      endpointValidation: 'static',
      runtimeEnabled: false,
    });

    expect(staticService.capabilities()).toEqual({
      configurationEnabled: true,
      runtimeEnabled: false,
      connectionTestEnabled: false,
      endpointValidation: 'static',
    });
    const saved = await staticService.create(teacherId, {
      providerKind: 'openai', providerName: 'manual', baseUrl: 'https://manual.example.test/v1', apiKey: 'sk-test', model: 'm',
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) createdConfigIds.push(saved.value.id);
    expect(dnsLookup).not.toHaveBeenCalled();

    const blocked = await staticService.create(teacherId, {
      providerKind: 'openai', providerName: 'metadata', baseUrl: 'http://169.254.169.254', apiKey: 'sk-test', model: 'm',
    });
    expect(blocked.ok).toBe(false);
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('create 禁段 baseUrl → validationError field=baseUrl，且不落库', async () => {
    const teacherId = await createTeacher('ssrfT');
    const before = await prisma.providerConfig.count({ where: { teacherId } });

    const result = await service.create(teacherId, {
      providerKind: 'openai',
      providerName: 'evil',
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      apiKey: 'sk-test',
      model: 'm',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('baseUrl');
    expect(result.error.message).toContain('baseUrl 不合法');

    const after = await prisma.providerConfig.count({ where: { teacherId } });
    expect(after).toBe(before); // 无落库
  });

  it('create 合法 → ok，落库值为规范化 URL（大写域名 → 小写 + 尾斜杠）', async () => {
    const teacherId = await createTeacher('ssrfOk');
    const result = await service.create(teacherId, {
      providerKind: 'openai',
      providerName: 'deepseek',
      baseUrl: 'http://EXAMPLE.com',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdConfigIds.push(result.value.id);
    expect(result.value.baseUrl).toBe('http://example.com/');

    const row = await prisma.providerConfig.findUnique({ where: { id: result.value.id } });
    expect(row?.baseUrl).toBe('http://example.com/');
  });

  it('update 改 baseUrl 为禁段 → 拒绝；改合法 → ok；不改 baseUrl → 不受影响', async () => {
    const teacherId = await createTeacher('ssrfUpd');
    const created = await service.create(teacherId, {
      providerKind: 'openai',
      providerName: 'a',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'm',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdConfigIds.push(created.value.id);

    // 改禁段 → 拒绝
    const bad = await service.update(teacherId, created.value.id, { baseUrl: 'http://127.0.0.1:5432' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe('VALIDATION_ERROR');
    expect(bad.error.field).toBe('baseUrl');

    // 改合法 → ok + 规范化落库
    const good = await service.update(teacherId, created.value.id, { baseUrl: 'http://API.deepseek.com' });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.baseUrl).toBe('http://api.deepseek.com/');

    // 不改 baseUrl → 其他字段正常更新
    const modelOnly = await service.update(teacherId, created.value.id, { model: 'deepseek-v3' });
    expect(modelOnly.ok).toBe(true);
    if (!modelOnly.ok) return;
    expect(modelOnly.value.model).toBe('deepseek-v3');
    expect(modelOnly.value.baseUrl).toBe('http://api.deepseek.com/');
  });
});

describe('provider-config 服务：update/remove 并入 teacherId（契约 §5 纵深）', () => {
  it('他人 teacherId + 已知 id → update/remove 均 notFound', async () => {
    const owner = await createTeacher('owner');
    const other = await createTeacher('other');
    const created = await service.create(owner, {
      providerKind: 'openai',
      providerName: 'a',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'm',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdConfigIds.push(created.value.id);

    const otherUpdate = await service.update(other, created.value.id, { model: 'hacked' });
    expect(otherUpdate.ok).toBe(false);
    if (otherUpdate.ok) return;
    expect(otherUpdate.error.code).toBe('NOT_FOUND');

    const otherRemove = await service.remove(other, created.value.id);
    expect(otherRemove.ok).toBe(false);
    if (otherRemove.ok) return;
    expect(otherRemove.error.code).toBe('NOT_FOUND');

    // 配置仍在（owner 未受影响）
    const list = await service.list(owner);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.some((item) => item.id === created.value.id)).toBe(true);
  });
});
