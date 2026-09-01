import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/database-trusted-clock.js';
import { createAuthService } from '../../../src/features/auth/index.js';

const prisma = new PrismaClient();
const clock = createDatabaseTrustedClock(prisma);
const auth = createAuthService({ prisma, clock });

afterAll(async () => { await prisma.$disconnect(); });

function uniqueEmail(prefix = 'auth-test'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

describe('AuthService', () => {
  it('register 成功：返回公开教师信息+token，SessionStore 只存哈希', async () => {
    const email = uniqueEmail();
    const result = await auth.register({ email, password: 'password123', displayName: '测试老师' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teacher.email).toBe(email);
    expect(result.value.teacher).not.toHaveProperty('passwordHash');
    expect(result.value.token.length).toBeGreaterThan(20);
    expect(result.value.expiresAtTs).toBeGreaterThan(Date.now());
    const tokenHash = createHash('sha256').update(result.value.token).digest('hex');
    const stored = await prisma.sessionStore.findUnique({ where: { tokenHash } });
    expect(stored).not.toBeNull();
    expect(stored!.teacherId).toBe(result.value.teacher.id);
  });

  it('register 重复邮箱返回 validationError', async () => {
    const email = uniqueEmail();
    await auth.register({ email, password: 'password123', displayName: 'A' });
    const second = await auth.register({ email, password: 'password123', displayName: 'B' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('VALIDATION_ERROR');
    expect(second.error.message).toContain('已注册');
  });

  it('register 校验：密码过短/邮箱格式错/昵称空', async () => {
    const short = await auth.register({ email: uniqueEmail(), password: 'short', displayName: 'A' });
    expect(short.ok).toBe(false);
    const badEmail = await auth.register({ email: 'not-an-email', password: 'password123', displayName: 'A' });
    expect(badEmail.ok).toBe(false);
    const noName = await auth.register({ email: uniqueEmail(), password: 'password123', displayName: ' ' });
    expect(noName.ok).toBe(false);
  });

  it('login 成功并可 validateToken', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: 'password123', displayName: 'A' });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const login = await auth.login({ email, password: 'password123' });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.value.token).not.toBe(reg.value.token);
    const valid = await auth.validateToken(login.value.token);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.teacherId).toBe(reg.value.teacher.id);
  });

  it('login 错误密码与不存在邮箱返回完全相同的错误（防枚举）', async () => {
    const email = uniqueEmail();
    await auth.register({ email, password: 'password123', displayName: 'A' });
    const wrongPassword = await auth.login({ email, password: 'wrong-password' });
    const unknownEmail = await auth.login({ email: uniqueEmail(), password: 'wrong-password' });
    expect(wrongPassword.ok).toBe(false);
    expect(unknownEmail.ok).toBe(false);
    if (wrongPassword.ok || unknownEmail.ok) return;
    expect(wrongPassword.error).toEqual(unknownEmail.error);
    expect(wrongPassword.error.code).toBe('PERMISSION_DENIED');
  });

  it('disabled 教师登录被拒', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: 'password123', displayName: 'A' });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    await prisma.teacherRegistry.update({ where: { id: reg.value.teacher.id }, data: { status: 'disabled' } });
    const login = await auth.login({ email, password: 'password123' });
    expect(login.ok).toBe(false);
    if (login.ok) return;
    expect(login.error.code).toBe('PERMISSION_DENIED');
  });

  it('logout 后 token 失效', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: 'password123', displayName: 'A' });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    await auth.logout(reg.value.token);
    const valid = await auth.validateToken(reg.value.token);
    expect(valid.ok).toBe(false);
    if (valid.ok) return;
    expect(valid.error.code).toBe('PERMISSION_DENIED');
  });

  it('过期 session 校验失败', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: 'password123', displayName: 'A' });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const tokenHash = createHash('sha256').update(reg.value.token).digest('hex');
    await prisma.sessionStore.update({
      where: { tokenHash },
      data: { expiresAtTs: new Date(Date.now() - 1000) },
    });
    const valid = await auth.validateToken(reg.value.token);
    expect(valid.ok).toBe(false);
    if (valid.ok) return;
    expect(valid.error.code).toBe('PERMISSION_DENIED');
  });

  it('getMe 返回公开信息且不含 passwordHash；未知教师 notFound', async () => {
    const email = uniqueEmail();
    const reg = await auth.register({ email, password: 'password123', displayName: 'A' });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const me = await auth.getMe(reg.value.teacher.id);
    expect(me.ok).toBe(true);
    if (me.ok) {
      expect(me.value.email).toBe(email);
      expect(me.value).not.toHaveProperty('passwordHash');
    }
    const missing = await auth.getMe('nonexistent-teacher-id');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');
  });
});
