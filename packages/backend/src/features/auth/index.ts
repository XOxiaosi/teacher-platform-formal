/**
 * P7/T-014 认证领域服务：邀请接受 / 登录 / 登出 / me / session 校验
 *
 * - 密码哈希：node:crypto scrypt + 随机盐 + timingSafeEqual 比对（不引入 bcrypt 等新依赖）。
 * - session：token = randomBytes(32).toString('base64url')，只把 sha256(token) 落库；
 *   过期 30 天（expiresAtTs = clock.now() + 30d）；校验走 TrustedClock，业务时间不直接 new Date()。
 * - 登录失败统一错误（邮箱不存在与密码错误返回同一错误），避免用户枚举。
 * - sessionSecret 为显式可配置的扩展位：预留给未来 actionToken 之类 HMAC 机制；
 *   当前 token 是随机不透明串，本任务不强制 HMAC。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { err, internalError, notFound, ok, permissionDenied, validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const DEFAULT_DATABASE_NAME = 'teacher_platform';
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 未知邮箱登录时也做一次等时比对，避免通过响应时间枚举账号
const DUMMY_HASH = hashPassword('timing-equalization-dummy-password');

function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64url');
  const expected = Buffer.from(parts[2], 'base64url');
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'P2002'
  );
}

export interface AuthServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  clock: TrustedClock;
  /** 显式可配置的会话/动作密钥扩展位（预留 HMAC 机制用，当前 token 为随机串，不依赖它） */
  sessionSecret?: string;
}

export interface AuthTeacherData {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAtTs: Date;
  updatedAtTs: Date;
}

export interface AuthSessionData {
  teacher: AuthTeacherData;
  token: string;
  /** 过期时间戳（epoch 毫秒） */
  expiresAtTs: number;
}

export interface AuthService {
  acceptInvitation(input: {
    token: string;
    password: string;
    displayName: string;
  }): Promise<Result<AuthSessionData, CommonError>>;
  login(input: { email: string; password: string }): Promise<Result<AuthSessionData, CommonError>>;
  logout(token: string): Promise<Result<{ ok: true }, CommonError>>;
  getMe(teacherId: string): Promise<Result<AuthTeacherData, CommonError>>;
  validateToken(token: string): Promise<Result<{ teacherId: string }, CommonError>>;
  /** P8 隐私自助化（t29）：校验教师邮箱+密码（不签发会话），供注销等高风险操作二次验证。 */
  verifyCredentials(input: {
    teacherId: string;
    email: string;
    password: string;
  }): Promise<Result<AuthTeacherData, CommonError>>;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { prisma, clock } = options;

  function toTeacherData(record: {
    id: string;
    email: string;
    passwordHash: string;
    displayName: string;
    status: string;
    createdAtTs: Date;
    updatedAtTs: Date;
  }): AuthTeacherData {
    // 教师公开信息：刻意不暴露 passwordHash / databaseName（后者是内部路由实现细节）。
    return {
      id: record.id,
      email: record.email,
      displayName: record.displayName,
      status: record.status === 'disabled' ? 'disabled' : 'active',
      createdAtTs: record.createdAtTs,
      updatedAtTs: record.updatedAtTs,
    };
  }

  async function issueSession(
    client: PrismaClient | Prisma.TransactionClient,
    teacherId: string,
  ): Promise<Result<{ token: string; expiresAtTs: number }, CommonError>> {
    const nowResult = await clock.now();
    if (!nowResult.ok) return err(nowResult.error);
    const now = nowResult.value;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return err(internalError('TrustedClock 返回无效时间'));
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAtTs = now.getTime() + SESSION_TTL_MS;
    await client.sessionStore.create({
      data: { tokenHash, teacherId, expiresAtTs: new Date(expiresAtTs) },
    });
    return ok({ token, expiresAtTs });
  }

  return {
    async acceptInvitation(input) {
      if (typeof input.token !== 'string' || input.token.length < 20) {
        return err(permissionDenied('邀请无效、已失效或已被使用'));
      }
      if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
        return err(validationError(`密码长度至少 ${MIN_PASSWORD_LENGTH} 位`, 'password'));
      }
      if (!input.displayName || input.displayName.trim() === '') {
        return err(validationError('昵称不能为空', 'displayName'));
      }

      try {
        const nowResult = await clock.now();
        if (!nowResult.ok) return err(nowResult.error);
        const now = nowResult.value;
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
          return err(internalError('TrustedClock 返回无效时间'));
        }
        // updateMany 是一次性消费的竞争闸门；与建号/签发 session 同处事务，任一失败均回滚消费。
        const result = await (prisma as PrismaClient).$transaction(async (tx) => {
          const consumed = await tx.teacherInvitation.updateMany({
            where: {
              tokenHash: hashToken(input.token),
              status: 'pending',
              expiresAtTs: { gt: now },
            },
            data: { status: 'accepted', acceptedAtTs: now },
          });
          if (consumed.count !== 1) return null;
          const invitation = await tx.teacherInvitation.findUnique({
            where: { tokenHash: hashToken(input.token) },
            select: { email: true },
          });
          // 理论上由 updateMany 成功保证存在；保守处理使 token 失败语义不泄露细节。
          if (!invitation) return null;
          const teacher = await tx.teacherRegistry.create({
            data: {
              email: invitation.email,
              passwordHash: hashPassword(input.password),
              displayName: input.displayName.trim(),
              databaseName: DEFAULT_DATABASE_NAME,
            },
          });
          const session = await issueSession(tx, teacher.id);
          if (!session.ok) throw new Error(`SESSION_ISSUE_FAILED:${session.error.message}`);
          return { teacher, session: session.value };
        });
        if (!result) return err(permissionDenied('邀请无效、已失效或已被使用'));
        return ok({
          teacher: toTeacherData(result.teacher),
          token: result.session.token,
          expiresAtTs: result.session.expiresAtTs,
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          // 接受端不区分邮箱已注册、token 已消费/过期或撤销，避免邀请/账号状态枚举。
          return err(permissionDenied('邀请无效、已失效或已被使用'));
        }
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`接受邀请失败：${message}`));
      }
    },

    async login(input) {
      const email = input.email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email)) {
        return err(validationError('邮箱格式不正确', 'email'));
      }

      try {
        const teacher = await prisma.teacherRegistry.findUnique({ where: { email } });
        // 未知邮箱也做一次等时比对，保持与“密码错误”一致的时间特征
        const passwordOk = teacher
          ? verifyPassword(input.password, teacher.passwordHash)
          : verifyPassword(input.password, DUMMY_HASH);
        if (!teacher || !passwordOk) {
          // 统一错误：邮箱不存在与密码错误返回完全相同的结果，避免用户枚举
          return err(permissionDenied('邮箱或密码错误'));
        }
        if (teacher.status !== 'active') {
          return err(permissionDenied('账号未激活或已停用'));
        }
        const session = await issueSession(prisma, teacher.id);
        if (!session.ok) return err(session.error);
        return ok({
          teacher: toTeacherData(teacher),
          token: session.value.token,
          expiresAtTs: session.value.expiresAtTs,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`登录失败：${message}`));
      }
    },

    async logout(token) {
      const tokenHash = hashToken(token);
      await prisma.sessionStore.deleteMany({ where: { tokenHash } });
      return ok({ ok: true as const });
    },

    async getMe(teacherId) {
      const teacher = await prisma.teacherRegistry.findUnique({ where: { id: teacherId } });
      if (!teacher) return err(notFound('教师不存在'));
      if (teacher.status !== 'active') return err(permissionDenied('账号未激活或已停用'));
      return ok(toTeacherData(teacher));
    },

    async validateToken(token) {
      const tokenHash = hashToken(token);
      const session = await prisma.sessionStore.findUnique({
        where: { tokenHash },
        include: { teacher: { select: { status: true } } },
      });
      if (!session) {
        return err(permissionDenied('会话无效或已过期'));
      }
      const nowResult = await clock.now();
      if (!nowResult.ok) return err(nowResult.error);
      const now = nowResult.value;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return err(internalError('TrustedClock 返回无效时间'));
      }
      if (session.expiresAtTs.getTime() <= now.getTime()) {
        await prisma.sessionStore.deleteMany({ where: { tokenHash } });
        return err(permissionDenied('会话已过期'));
      }
      if (session.teacher.status !== 'active') {
        await prisma.sessionStore.deleteMany({ where: { tokenHash } });
        return err(permissionDenied('会话无效或已过期'));
      }
      return ok({ teacherId: session.teacherId });
    },

    async verifyCredentials(input) {
      const email = input.email.trim().toLowerCase();
      try {
        const teacher = await prisma.teacherRegistry.findUnique({ where: { id: input.teacherId } });
        // 统一错误（邮箱不存在/邮箱不匹配/密码错误同文案），防账号枚举
        if (!teacher || teacher.email !== email) {
          return err(permissionDenied('邮箱或密码错误'));
        }
        const passwordOk = verifyPassword(input.password, teacher.passwordHash);
        if (!passwordOk) {
          return err(permissionDenied('邮箱或密码错误'));
        }
        if (teacher.status !== 'active') {
          return err(permissionDenied('账号未激活或已停用'));
        }
        return ok(toTeacherData(teacher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`凭据校验失败：${message}`));
      }
    },
  };
}
