import { randomBytes } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'd'.repeat(64);

const prisma = new PrismaClient();
const app = createApp(prisma, { localSafeMode: true });
const teacherIds: string[] = [];

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await prisma.providerConfig.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'local-safe-provider-' } } });
  await prisma.$disconnect();
  delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
});

async function registerTeacher(): Promise<string> {
  const email = `local-safe-provider-${randomBytes(6).toString('hex')}@example.com`;
  const { response } = await acceptInvitation(app, prisma, {
    email,
    password: 'password123',
    displayName: '本机配置测试',
  });
  expect(response.status).toBe(201);
  teacherIds.push(response.body.data.teacher.id);
  return response.headers['set-cookie'][0].split(';')[0];
}

describe.sequential('本机安全模式 provider 配置管理', () => {
  it('仅开放受保护配置 CRUD 和静态校验：没有 DNS、fetch 或连接探测', async () => {
    const cookie = await registerTeacher();
    const dnsSpy = vi.spyOn(dnsPromises, 'lookup');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const capabilities = await request(app).get('/api/v1/provider-configs/capabilities').set('Cookie', cookie);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.data).toEqual({
      configurationEnabled: true,
      runtimeEnabled: false,
      connectionTestEnabled: false,
      endpointValidation: 'static',
    });

    const first = await request(app).post('/api/v1/provider-configs').set('Cookie', cookie).send({
      providerKind: 'openai', providerName: 'manual-one', baseUrl: 'https://manual.example.test/v1', apiKey: 'sk-local-secret-1111', model: 'model-one',
    });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ isPrimary: true, apiKeyMasked: 'sk-****1111', model: 'model-one' });
    expect(JSON.stringify(first.body)).not.toContain('sk-local-secret-1111');

    const second = await request(app).post('/api/v1/provider-configs').set('Cookie', cookie).send({
      providerKind: 'openai', providerName: 'manual-two', baseUrl: 'https://two.example.test/v1', apiKey: 'sk-local-secret-2222', model: 'model-two',
    });
    expect(second.status).toBe(201);

    const selected = await request(app)
      .patch(`/api/v1/provider-configs/${second.body.data.id}`)
      .set('Cookie', cookie)
      .send({ isPrimary: true, model: 'model-two-updated' });
    expect(selected.status).toBe(200);
    expect(selected.body.data).toMatchObject({ isPrimary: true, model: 'model-two-updated' });

    const list = await request(app).get('/api/v1/provider-configs').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain('sk-local-secret-');

    const probe = await request(app).post(`/api/v1/provider-configs/${second.body.data.id}/test`).set('Cookie', cookie);
    expect(probe.status).toBe(200);
    expect(probe.body.data).toMatchObject({
      ok: false,
      providerError: { kind: 'unknown', status: 0, retryable: false },
    });
    expect(probe.body.data.providerError.message).toContain('本机安全模式');
    expect(dnsSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
