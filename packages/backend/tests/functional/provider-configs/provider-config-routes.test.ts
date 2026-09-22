import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProviderConfigRouter } from '../../../src/app/routes/provider-config.routes.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createProviderConfigService } from '../../../src/features/provider-configs/index.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import type { DnsLookup } from '../../../src/shared/ssrf/endpoint-guard.js';
import { acceptInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'b'.repeat(64);

/** 测试用 DNS：hostname 一律解析到公网 TEST-NET（避免真实网络依赖）。 */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

const authService = createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) });
const service = createProviderConfigService({ prisma, dnsLookup: publicDns, allowedCidrs: [] });
const providerRouter = createProviderConfigRouter(service, authService);
const authRouter = createAuthRouter(authService);

const app = express();
app.use(express.json());
app.use('/api/v1', authRouter);
app.use('/api/v1', providerRouter);

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.providerConfig.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'pc-route-' } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
});

async function registerTeacher(): Promise<{ cookie: string; teacherId: string }> {
  const email = `pc-route-${randomBytes(6).toString('hex')}@example.com`;
  const { response: res } = await acceptInvitation(app, prisma, {
    email,
    password: 'password123',
    displayName: '路由测试',
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  const teacherId = res.body.data.teacher.id;
  createdTeacherIds.push(teacherId);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, teacherId };
}

const PAYLOAD = {
  providerKind: 'openai',
  providerName: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-route-secret-9999',
  model: 'deepseek-chat',
};

describe('provider-config 路由', () => {
  it('未认证访问 → 401', async () => {
    const res = await request(app).get('/api/v1/provider-configs');
    expect(res.status).toBe(401);
  });

  it('完整 CRUD：create（首条 primary）→ list（无明文/密文）→ update → delete', async () => {
    const { cookie } = await registerTeacher();

    // create → 201 首条 isPrimary
    const created = await request(app)
      .post('/api/v1/provider-configs')
      .set('Cookie', cookie)
      .send(PAYLOAD);
    expect(created.status).toBe(201);
    expect(created.body.data.isPrimary).toBe(true);
    expect(created.body.data.apiKeyMasked).toBe('sk-****9999');
    expect(created.body.data).not.toHaveProperty('apiKey');
    expect(created.body.data).not.toHaveProperty('apiKeyEnc');
    const configId = created.body.data.id;

    // list → 只含 masked
    const list = await request(app).get('/api/v1/provider-configs').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('sk-route-secret-9999');
    expect(JSON.stringify(list.body)).not.toContain('apiKeyEnc');

    // update model
    const updated = await request(app)
      .patch(`/api/v1/provider-configs/${configId}`)
      .set('Cookie', cookie)
      .send({ model: 'deepseek-v3' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.model).toBe('deepseek-v3');

    // test endpoint：未显式注入探针时必须明确 not_run，不能伪造成功。
    const test = await request(app)
      .post(`/api/v1/provider-configs/${configId}/test`)
      .set('Cookie', cookie);
    expect(test.status).toBe(200);
    expect(test.body.data.ok).toBe(false);
    expect(test.body.data.providerName).toBe('deepseek');
    expect(test.body.data.model).toBe('deepseek-v3');
    expect(test.body.data.providerError).toMatchObject({ kind: 'unknown', status: 0, retryable: false });
    expect(test.body.data.providerError.message).toContain('未发起网络请求');

    // delete
    const removed = await request(app)
      .delete(`/api/v1/provider-configs/${configId}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
    expect(removed.body.data.removed).toBe(true);

    // 删除后列表空
    const after = await request(app).get('/api/v1/provider-configs').set('Cookie', cookie);
    expect(after.body.data).toHaveLength(0);
  });

  it('capabilities 在 /:id 前匹配，明确非本机模式的 DNS 守卫与禁用探测', async () => {
    const { cookie } = await registerTeacher();
    const res = await request(app).get('/api/v1/provider-configs/capabilities').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: {
        configurationEnabled: true,
        runtimeEnabled: true,
        connectionTestEnabled: false,
        endpointValidation: 'dns-guarded',
      },
    });
  });

  it('owner 隔离：A 的配置 B 通过 HTTP 改/删 → 404', async () => {
    const a = await registerTeacher();
    const b = await registerTeacher();
    const created = await request(app).post('/api/v1/provider-configs').set('Cookie', a.cookie).send(PAYLOAD);
    expect(created.status).toBe(201);
    const configId = created.body.data.id;

    const bPatch = await request(app)
      .patch(`/api/v1/provider-configs/${configId}`)
      .set('Cookie', b.cookie)
      .send({ model: 'hacked' });
    expect(bPatch.status).toBe(404);

    const bDelete = await request(app)
      .delete(`/api/v1/provider-configs/${configId}`)
      .set('Cookie', b.cookie);
    expect(bDelete.status).toBe(404);

    const bTest = await request(app)
      .post(`/api/v1/provider-configs/${configId}/test`)
      .set('Cookie', b.cookie);
    expect(bTest.status).toBe(404);
  });

  it('校验：非法 providerKind → 400', async () => {
    const { cookie } = await registerTeacher();
    const res = await request(app)
      .post('/api/v1/provider-configs')
      .set('Cookie', cookie)
      .send({ ...PAYLOAD, providerKind: 'gpt' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('SSRF：POST baseUrl=169.254.169.254 → 400 VALIDATION_ERROR field=baseUrl（契约 §6.4）', async () => {
    const { cookie } = await registerTeacher();
    const res = await request(app)
      .post('/api/v1/provider-configs')
      .set('Cookie', cookie)
      .send({ ...PAYLOAD, baseUrl: 'http://169.254.169.254' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.field).toBe('baseUrl');
  });
});
