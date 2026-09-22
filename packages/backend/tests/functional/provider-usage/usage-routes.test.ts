import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createUsageRouter } from '../../../src/app/routes/usage.routes.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createProviderUsageService } from '../../../src/features/provider-usage/index.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { acceptInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
const authService = createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) });
const usageService = createProviderUsageService({ prisma });
const usageRouter = createUsageRouter(usageService, authService);
const authRouter = createAuthRouter(authService);

const app = express();
app.use(express.json());
app.use('/api/v1', authRouter);
app.use('/api/v1', usageRouter);

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.providerUsage.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'usage-route-' } } });
  await prisma.$disconnect();
});

async function registerTeacher(): Promise<{ cookie: string; teacherId: string }> {
  const email = `usage-route-${randomBytes(6).toString('hex')}@example.com`;
  const { response: res } = await acceptInvitation(app, prisma, {
    email,
    password: 'password123',
    displayName: '用量测试',
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  const teacherId = res.body.data.teacher.id;
  createdTeacherIds.push(teacherId);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, teacherId };
}

describe('usage summary 路由', () => {
  it('未认证 → 401', async () => {
    const res = await request(app).get('/api/v1/usage/summary?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z');
    expect(res.status).toBe(401);
  });

  it('summary 返回聚合；owner 隔离（A 看不到 B 用量）', async () => {
    const a = await registerTeacher();
    const b = await registerTeacher();

    await usageService.record({
      teacherId: a.teacherId,
      providerName: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 100,
      completionTokens: 20,
      requestAt: new Date('2026-08-30T01:00:00.000Z'),
    });

    const resA = await request(app)
      .get('/api/v1/usage/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z')
      .set('Cookie', a.cookie);
    expect(resA.status).toBe(200);
    expect(resA.body.ok).toBe(true);
    expect(resA.body.data.totals.promptTokens).toBe(100);
    expect(resA.body.data.totals.completionTokens).toBe(20);
    expect(resA.body.data.totals.requests).toBe(1);
    expect(resA.body.data.byProvider[0].providerName).toBe('deepseek');

    const resB = await request(app)
      .get('/api/v1/usage/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z')
      .set('Cookie', b.cookie);
    expect(resB.status).toBe(200);
    expect(resB.body.data.totals.requests).toBe(0); // owner 隔离
  });

  it('参数校验：from/to 缺失或非法 → 400', async () => {
    const { cookie } = await registerTeacher();
    const missing = await request(app).get('/api/v1/usage/summary').set('Cookie', cookie);
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .get('/api/v1/usage/summary?from=abc&to=2026-08-31T00:00:00.000Z')
      .set('Cookie', cookie);
    expect(invalid.status).toBe(400);

    const reversed = await request(app)
      .get('/api/v1/usage/summary?from=2026-08-31T00:00:00.000Z&to=2026-08-01T00:00:00.000Z')
      .set('Cookie', cookie);
    expect(reversed.status).toBe(400);
  });
});
