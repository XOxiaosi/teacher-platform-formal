import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/database-trusted-clock.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { seedInvitation } from '../../helpers/invitations.js';

const prisma = new PrismaClient();
const clock = createDatabaseTrustedClock(prisma);
const auth = createAuthService({ prisma, clock });
const teacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.teacherInvitation.deleteMany();
  await prisma.$disconnect();
});

function uniqueEmail(prefix = 'auth-test'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

async function accept(email = uniqueEmail()) {
  const invitation = await seedInvitation(prisma, { email });
  const result = await auth.acceptInvitation({ token: invitation.token, password: 'password123', displayName: '测试老师' });
  if (result.ok) teacherIds.push(result.value.teacher.id);
  return { invitation, result };
}

describe('AuthService invitation acceptance', () => {
  it('接受邀请成功：只存 tokenHash，返回公开教师 DTO（不含 databaseName）', async () => {
    const { invitation, result } = await accept();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teacher).not.toHaveProperty('passwordHash');
    expect(result.value.teacher).not.toHaveProperty('databaseName');
    const tokenHash = createHash('sha256').update(result.value.token).digest('hex');
    expect(await prisma.sessionStore.findUnique({ where: { tokenHash } })).not.toBeNull();
    const storedInvitation = await prisma.teacherInvitation.findUnique({ where: { id: invitation.id } });
    expect(storedInvitation?.status).toBe('accepted');
    expect(storedInvitation?.tokenHash).not.toBe(invitation.token);
  });

  it('同一邀请并发只允许一次成功', async () => {
    const invitation = await seedInvitation(prisma, { email: uniqueEmail('race') });
    const [a, b] = await Promise.all([
      auth.acceptInvitation({ token: invitation.token, password: 'password123', displayName: 'A' }),
      auth.acceptInvitation({ token: invitation.token, password: 'password123', displayName: 'B' }),
    ]);
    const successes = [a, b].filter((item) => item.ok);
    expect(successes).toHaveLength(1);
    if (successes[0]?.ok) teacherIds.push(successes[0].value.teacher.id);
    const failures = [a, b].filter((item) => !item.ok);
    expect(failures).toHaveLength(1);
    if (!failures[0]?.ok) expect(failures[0]?.error).toEqual({ code: 'PERMISSION_DENIED', message: '邀请无效、已失效或已被使用' });
  });

  it('已撤销、已过期和伪造 token 返回相同错误（不枚举）', async () => {
    const revoked = await seedInvitation(prisma, { email: uniqueEmail('revoked'), status: 'revoked' });
    const expired = await seedInvitation(prisma, { email: uniqueEmail('expired'), expiresAtTs: new Date(Date.now() - 1000) });
    const results = await Promise.all([
      auth.acceptInvitation({ token: revoked.token, password: 'password123', displayName: 'A' }),
      auth.acceptInvitation({ token: expired.token, password: 'password123', displayName: 'A' }),
      auth.acceptInvitation({ token: randomBytes(32).toString('base64url'), password: 'password123', displayName: 'A' }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: 'PERMISSION_DENIED', message: '邀请无效、已失效或已被使用' });
    }
  });

  it('登录成功，停用立即注销旧 session；恢复不恢复旧 session', async () => {
    const email = uniqueEmail('status');
    const { result } = await accept(email);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await auth.validateToken(result.value.token)).ok).toBe(true);
    await prisma.$transaction(async (tx) => {
      await tx.teacherRegistry.update({ where: { id: result.value.teacher.id }, data: { status: 'disabled' } });
      await tx.sessionStore.deleteMany({ where: { teacherId: result.value.teacher.id } });
    });
    expect((await auth.validateToken(result.value.token)).ok).toBe(false);
    await prisma.teacherRegistry.update({ where: { id: result.value.teacher.id }, data: { status: 'active' } });
    expect((await auth.validateToken(result.value.token)).ok).toBe(false);
    expect((await auth.login({ email, password: 'password123' })).ok).toBe(true);
  });
});
