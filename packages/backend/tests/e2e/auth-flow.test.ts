import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { seedInvitation } from '../helpers/invitations.js';

const prisma = new PrismaClient();
const app = createApp(prisma);
const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.teacherInvitation.deleteMany();
  await prisma.$disconnect();
});

function uniqueEmail(prefix = 'auth-flow'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

describe('邀请制教师认证', () => {
  it('公开 /auth/register 不存在；接受邀请才可创建账户并签发 cookie', async () => {
    const closed = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'password123', displayName: '不应创建' });
    expect(closed.status).toBe(404);

    const email = uniqueEmail();
    const invitation = await seedInvitation(prisma, { email });
    const accepted = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token: invitation.token, password: 'password123', displayName: '测试老师' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.teacher.email).toBe(email);
    expect(accepted.body.data.teacher).not.toHaveProperty('databaseName');
    createdTeacherIds.push(accepted.body.data.teacher.id);
    const cookie = Array.isArray(accepted.headers['set-cookie'])
      ? accepted.headers['set-cookie'][0]
      : String(accepted.headers['set-cookie']);
    expect(cookie).toContain('sessionToken=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('同一邀请、已撤销邀请和过期邀请均无法接受', async () => {
    const invitation = await seedInvitation(prisma, { email: uniqueEmail('replay') });
    const first = await request(app).post('/api/v1/auth/invitations/accept').send({ token: invitation.token, password: 'password123', displayName: 'A' });
    expect(first.status).toBe(201);
    createdTeacherIds.push(first.body.data.teacher.id);
    const replay = await request(app).post('/api/v1/auth/invitations/accept').send({ token: invitation.token, password: 'password123', displayName: 'B' });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe('邀请无效、已失效或已被使用');

    const revoked = await seedInvitation(prisma, { email: uniqueEmail('revoked'), status: 'revoked' });
    const expired = await seedInvitation(prisma, { email: uniqueEmail('expired'), expiresAtTs: new Date(Date.now() - 1000) });
    for (const token of [revoked.token, expired.token]) {
      const response = await request(app).post('/api/v1/auth/invitations/accept').send({ token, password: 'password123', displayName: 'A' });
      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('邀请无效、已失效或已被使用');
    }
  });

  it('接受 → me → 登出链路；登录仍可用', async () => {
    const agent = request.agent(app);
    const email = uniqueEmail('me');
    const invitation = await seedInvitation(prisma, { email });
    const accepted = await agent.post('/api/v1/auth/invitations/accept').send({ token: invitation.token, password: 'password123', displayName: '链路老师' });
    expect(accepted.status).toBe(201);
    createdTeacherIds.push(accepted.body.data.teacher.id);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data).not.toHaveProperty('databaseName');
    const logout = await agent.post('/api/v1/auth/logout');
    expect(logout.status).toBe(200);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'password123' });
    expect(login.status).toBe(200);
  });
});
