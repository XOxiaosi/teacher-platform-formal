import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createAdminAuthService, createAdminRouter, hashAdminPassword } from '../../../src/features/admin/index.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import type { DatabaseClientPool } from '../../../src/shared/database-pool/index.js';

const prisma = new PrismaClient();
const admin = createAdminAuthService({ email: 't014-admin@example.com', passwordHash: hashAdminPassword('admin-secret-123') });
const app = express();
app.use(express.json());
app.use('/api/v1/admin', createAdminRouter({
  authService: admin,
  registryPrisma: prisma,
  pool: {} as DatabaseClientPool,
}));
app.use('/api/v1', createAuthRouter(createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) })));
const teacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 't014-' } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorEmail: 't014-admin@example.com' } });
  await prisma.$disconnect();
});

function email(prefix = 't014'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

async function adminAgent() {
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/admin/auth/login').send({ email: 't014-admin@example.com', password: 'admin-secret-123' });
  expect(login.status).toBe(200);
  return agent;
}

describe('管理员邀请与默认最小可见性', () => {
  it('管理员创建、列表、撤销邀请；token 只在创建响应中出现一次', async () => {
    const agent = await adminAgent();
    const created = await agent.post('/api/v1/admin/invitations').send({ email: email(), expiresInHours: 72 });
    expect(created.status).toBe(201);
    expect(created.body.data.invitation.status).toBe('pending');
    expect(created.body.data.token).toEqual(expect.any(String));
    const token = created.body.data.token as string;
    const id = created.body.data.invitation.id as string;
    const stored = await prisma.teacherInvitation.findUnique({ where: { id } });
    expect(stored?.tokenHash).not.toBe(token);

    const listed = await agent.get('/api/v1/admin/invitations');
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toEqual(expect.any(Array));
    const item = listed.body.data.items.find((value: { id: string }) => value.id === id);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('tokenHash');

    const revoked = await agent.post(`/api/v1/admin/invitations/${id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.invitation.status).toBe('revoked');
    const accepted = await request(app).post('/api/v1/auth/invitations/accept').send({ token, password: 'password123', displayName: '不可接受' });
    expect(accepted.status).toBe(401);
  });

  it('列表映射已接受状态为 consumed，并拒绝非 number 的 expiresInHours 且不创建邀请', async () => {
    const agent = await adminAgent();
    const created = await agent.post('/api/v1/admin/invitations').send({ email: email('t014-consumed'), expiresInHours: 72 });
    expect(created.status).toBe(201);
    const accepted = await request(app).post('/api/v1/auth/invitations/accept').send({
      token: created.body.data.token,
      password: 'password123',
      displayName: '已接受老师',
    });
    expect(accepted.status).toBe(201);
    const before = await prisma.teacherInvitation.count();
    const invalidValues: unknown[] = [true, '72', [], {}, null];
    for (const value of invalidValues) {
      const response = await agent.post('/api/v1/admin/invitations').send({ email: email('t014-invalid'), expiresInHours: value });
      expect(response.status).toBe(400);
    }
    expect(await prisma.teacherInvitation.count()).toBe(before);

    const listed = await agent.get('/api/v1/admin/invitations');
    expect(listed.status).toBe(200);
    const item = listed.body.data.items.find((value: { id: string }) => value.id === created.body.data.invitation.id);
    expect(item).toMatchObject({ status: 'consumed', email: created.body.data.invitation.email });
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('tokenHash');
  });

  it('教师停用立即删除全部 session；恢复不会复活旧 token', async () => {
    const agent = await adminAgent();
    const created = await agent.post('/api/v1/admin/invitations').send({ email: email(), expiresInHours: 1 });
    const accepted = await request(app).post('/api/v1/auth/invitations/accept').send({ token: created.body.data.token, password: 'password123', displayName: '会话老师' });
    expect(accepted.status).toBe(201);
    const teacherId = accepted.body.data.teacher.id as string;
    teacherIds.push(teacherId);
    const sessionCookie = (accepted.headers['set-cookie'] as string[])[0];
    const disabled = await agent.patch(`/api/v1/admin/teachers/${teacherId}/status`).send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect(await prisma.sessionStore.count({ where: { teacherId } })).toBe(0);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie)).status).toBe(401);
    const enabled = await agent.patch(`/api/v1/admin/teachers/${teacherId}/status`).send({ status: 'active' });
    expect(enabled.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', sessionCookie)).status).toBe(401);
  });

  it('管理员默认不能进入教师业务详情、互动、反馈或备份恢复；旧建号端点也不存在', async () => {
    const agent = await adminAgent();
    for (const path of ['/api/v1/admin/teachers/any-id', '/api/v1/admin/interactions', '/api/v1/admin/feedback', '/api/v1/admin/feedback/summary', '/api/v1/admin/backup/status']) {
      expect((await agent.get(path)).status).toBe(404);
    }
    expect((await agent.post('/api/v1/admin/backup?confirm=1')).status).toBe(404);
    expect((await agent.post('/api/v1/admin/restore?confirm=1')).status).toBe(404);
    expect((await agent.post('/api/v1/admin/teachers').send({ email: email(), password: 'password123', displayName: '不应创建' })).status).toBe(404);
  });
});
