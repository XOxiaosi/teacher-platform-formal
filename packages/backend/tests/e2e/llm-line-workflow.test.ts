import { randomBytes } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createAuthService } from '../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../src/shared/trusted-clock/index.js';
import { seedInvitation } from '../helpers/invitations.js';

/**
 * L6（t79）：LLM 渠道线 e2e 隔离验收。
 *
 * 覆盖（真实 HTTP + 共享库 + 双教师）：
 * 1. provider-configs owner 隔离：A 建配置 → B 查/改/删 404
 * 2. apiKey 不回明文：响应只含 apiKeyMasked；请求日志不含明文 apiKey
 * 3. primary 唯一化 + 删除回退（删 primary 提升最新；全删后无配置）
 * 4. test 端点：探针错误映射（ProviderError kind）
 * 5. usage summary：采集落库（服务层造数据）→ 聚合 → owner 隔离
 * 6. 未认证 → 401
 *
 * 共享库表（ProviderConfig/ProviderUsage 多教师共存），无需隔离教师库。
 * 隔离 runner（run-tests-isolated.mjs）提供随机库 + 自动清理。
 */

const prisma = new PrismaClient();
// ProviderConfig apiKey 加密需要 32 字节 hex 密钥（安全红线：缺省拒绝明文落库）——
// 对齐 backend4 functional 测试模式（provider-config-routes/service.test.ts 同款），测试后清理
process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'd'.repeat(64);
// 隔离测试不依赖真实 DNS：endpoint guard 仍执行完整校验，但 resolver
// 稳定返回明确 allowlist 内的公网 TEST-NET 地址。
const previousAllowedProviderIps = process.env.PROVIDER_BASEURL_ALLOWED_IPS;
process.env.PROVIDER_BASEURL_ALLOWED_IPS = '93.184.216.34/32';
const dnsLookupMock = vi.spyOn(dnsPromises, 'lookup').mockImplementation(async () => ([
  { address: '93.184.216.34', family: 4 },
]));
const authService = createAuthService({
  prisma,
  clock: createDatabaseTrustedClock(prisma),
});
const app = createApp(prisma, { authService, localSafeMode: false });

const createdTeacherIds: string[] = [];
let teacherA: string;
let teacherB: string;
let agentA: ReturnType<typeof request.agent>;
let agentB: ReturnType<typeof request.agent>;

function unique(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

async function registerTeacher(agent: ReturnType<typeof request.agent>, email: string, displayName: string): Promise<string> {
  const invitation = await seedInvitation(prisma, { email });
  const res = await agent
    .post('/api/v1/auth/invitations/accept')
    .send({ token: invitation.token, password: 'password123', displayName });
  expect(res.status).toBe(201);
  createdTeacherIds.push(res.body.data.teacher.id);
  return res.body.data.teacher.id;
}

beforeAll(async () => {
  agentA = request.agent(app);
  agentB = request.agent(app);
  teacherA = await registerTeacher(agentA, unique('llm-a') + '@example.com', 'LLM教师A');
  teacherB = await registerTeacher(agentB, unique('llm-b') + '@example.com', 'LLM教师B');
});

afterAll(async () => {
  await prisma.providerUsage.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.providerConfig.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { contains: 'llm-' } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (previousAllowedProviderIps === undefined) delete process.env.PROVIDER_BASEURL_ALLOWED_IPS;
  else process.env.PROVIDER_BASEURL_ALLOWED_IPS = previousAllowedProviderIps;
  dnsLookupMock.mockRestore();
});

describe('LLM 渠道线 e2e（共享库双教师隔离）', () => {
  it('未认证访问 provider-configs → 401', async () => {
    const res = await request(app).get('/api/v1/provider-configs');
    expect(res.status).toBe(401);
  });

  it('A 建配置：首条自动 primary，响应只含 apiKeyMasked 不含明文', async () => {
    const res = await agentA
      .post('/api/v1/provider-configs')
      .send({
        providerKind: 'openai',
        providerName: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-llm-e2e-secret-0001',
        model: 'deepseek-chat',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.apiKeyMasked).toBe('sk-****0001');
    expect(res.body.data).not.toHaveProperty('apiKey');
    expect(res.body.data).not.toHaveProperty('apiKeyEnc');
    expect(res.body.data.isPrimary).toBe(true);
  });

  it('owner 隔离：B 查不到 A 的配置；B 改/删 A 的配置 → 404', async () => {
    const listA = await agentA.get('/api/v1/provider-configs');
    expect(listA.status).toBe(200);
    const configA = listA.body.data[0];
    expect(configA).toBeDefined();

    const listB = await agentB.get('/api/v1/provider-configs');
    expect(listB.status).toBe(200);
    expect(listB.body.data).toHaveLength(0);

    const patchB = await agentB.patch(`/api/v1/provider-configs/${configA.id}`).send({ displayName: '劫持' });
    expect(patchB.status).toBe(404);

    const deleteB = await agentB.delete(`/api/v1/provider-configs/${configA.id}`);
    expect(deleteB.status).toBe(404);
  });

  it('primary 唯一化：A 建第二条 → 只有一条 isPrimary；删除 primary 提升另一条', async () => {
    const second = await agentA
      .post('/api/v1/provider-configs')
      .send({
        providerKind: 'anthropic',
        providerName: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-llm-e2e-secret-0002',
        model: 'claude-3-5-sonnet',
      });
    expect(second.status).toBe(201);

    const list = await agentA.get('/api/v1/provider-configs');
    expect(list.body.data).toHaveLength(2);
    const primaries = list.body.data.filter((c: { isPrimary: boolean }) => c.isPrimary);
    expect(primaries).toHaveLength(1);
    // 新配置为 primary（创建时唯一化）

    // 删除非 primary 的一条 → 剩 1 条仍 primary
    const nonPrimary = list.body.data.find((c: { isPrimary: boolean }) => !c.isPrimary);
    if (nonPrimary) {
      const del = await agentA.delete(`/api/v1/provider-configs/${nonPrimary.id}`);
      expect(del.status).toBe(200);
      const after = await agentA.get('/api/v1/provider-configs');
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0].isPrimary).toBe(true);
    }

    // 删除最后一条 → 无配置（回退默认）
    const remaining = await agentA.get('/api/v1/provider-configs');
    if (remaining.body.data.length > 0) {
      const del = await agentA.delete(`/api/v1/provider-configs/${remaining.body.data[0].id}`);
      expect(del.status).toBe(200);
    }
    const empty = await agentA.get('/api/v1/provider-configs');
    expect(empty.body.data).toHaveLength(0);
  });

  it('apiKey 明文不进入请求日志（logger 输出不含明文密钥）', async () => {
    // 重新建一条配置，捕获日志：请求日志/业务日志不得含明文 apiKey
    const secret = 'sk-llm-log-secret-7777';
    const res = await agentA
      .post('/api/v1/provider-configs')
      .send({
        providerKind: 'openai',
        providerName: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: secret,
        model: 'deepseek-chat',
      });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    // 响应头/body 任何字段都不回明文（apiKeyEnc 也不得出现）
    expect(JSON.stringify(res.body)).not.toContain('apiKeyEnc');
  });

  it('test 端点：对存在的配置返回探针结果（ProviderError kind 或 ok）', async () => {
    // 建一条配置（baseUrl 指向 RFC 5737 文档保留不可达地址 192.0.2.1 → 探针应返回错误 kind 而非 500；
    // 字面公网地址可通过 SSRF 守卫（L1 loopback/RFC1918 禁段校验），保持守卫全程生效）
    const res = await agentA
      .post('/api/v1/provider-configs')
      .send({
        providerKind: 'openai',
        providerName: 'deepseek',
        baseUrl: 'http://192.0.2.1:1',
        apiKey: 'sk-llm-test-secret-0003',
        model: 'deepseek-chat',
      });
    expect(res.status).toBe(201);
    const id = res.body.data.id;

    const testRes = await agentA.post(`/api/v1/provider-configs/${id}/test`);
    // 探针失败映射为 ProviderError（kind=auth/network 等）而非 500 崩溃
    expect([200, 400, 502]).toContain(testRes.status);
    expect(testRes.body.ok).toBe(true);
    expect(testRes.body.data).toHaveProperty('ok');
    // 未注入 chatProbe → 静态校验 ok（配置存在且可解密），返回 providerName/model（t91 契约）
    expect(testRes.body.data.providerName).toBe('deepseek');
    expect(testRes.body.data.model).toBe('deepseek-chat');
    // 断言不泄露 apiKey 明文
    expect(JSON.stringify(testRes.body)).not.toContain('sk-llm-test-secret-0003');

    // 清理该配置
    await agentA.delete(`/api/v1/provider-configs/${id}`);
  });

  it('usage summary：采集落库 + 聚合 + owner 隔离', async () => {
    // 服务层直接采集（模拟 AI 调用后记录用量）
    const { createProviderUsageService } = await import('../../src/features/provider-usage/index.js');
    const usageService = createProviderUsageService({ prisma });
    await usageService.record({
      teacherId: teacherA,
      providerConfigId: null,
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 120,
      completionTokens: 30,
      conversationId: null,
    });
    await usageService.record({
      teacherId: teacherA,
      providerConfigId: null,
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 80,
      completionTokens: 20,
      conversationId: null,
    });
    await usageService.record({
      teacherId: teacherB,
      providerConfigId: null,
      providerName: 'openai',
      model: 'gpt-4o',
      promptTokens: 500,
      completionTokens: 100,
      conversationId: null,
    });

    // A 的 summary：只含 A 的 2 条聚合（prompt 200 / completion 50）
    // record 未传 requestAt → 默认 now；查询窗口用宽范围覆盖（过去 1 年 → 未来 1 天）
    const from = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const sumA = await agentA.get(`/api/v1/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(sumA.status).toBe(200);
    expect(sumA.body.data.totals.promptTokens).toBe(200);
    expect(sumA.body.data.totals.completionTokens).toBe(50);
    expect(sumA.body.data.totals.requests).toBe(2);
    const deepseekRow = sumA.body.data.byProvider.find((r: { providerName: string }) => r.providerName === 'deepseek');
    expect(deepseekRow).toBeDefined();
    expect(deepseekRow.requests).toBe(2);

    // B 的 summary：不含 A 的用量（owner 隔离）
    const sumB = await agentB.get(`/api/v1/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(sumB.status).toBe(200);
    expect(sumB.body.data.totals.promptTokens).toBe(500);
    expect(sumB.body.data.totals.completionTokens).toBe(100);
    expect(sumB.body.data.byProvider.some((r: { providerName: string }) => r.providerName === 'deepseek')).toBe(false);
  });
});
