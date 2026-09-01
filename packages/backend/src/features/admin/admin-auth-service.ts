/**
 * 后台管理员认证领域服务（P7 渠道线 A2，阶段一 env 版）。
 *
 * 设计依据：reports/architecture/p7-admin-panel-design.md §3.2/§6
 * - 账号：ADMIN_EMAIL + ADMIN_PASSWORD_HASH（scrypt$salt$derived，与教师同算法/格式）；
 *   env 缺失经 createAdminAuthServiceFromEnv 启动即抛错（与 ACTION_TOKEN_SECRET 同风格）。
 * - 会话：内存 Map<tokenHash, {email, expiresAt}>——重启需重登（阶段一单实例可接受）；
 *   过期用 performance.now()（单调时钟：会话 TTL 不受系统时钟跳变影响，且不触碰
 *   current-time 边界扫描 R1——与 rate-limit 同纪律）。
 * - 登录：scrypt 校验 + timingSafeEqual；统一错误（邮箱不存在/密码错误同 401 防枚举）。
 * - 阶段二（additive 表 AdminAccount/AdminAuditLog）时本服务保持接口形状，实现换表。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { err, ok, permissionDenied, validationError, type CommonError, type Result } from '@teacher-platform/contracts';

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AdminAuthServiceOptions {
  /** 管理员邮箱（ADMIN_EMAIL） */
  email: string;
  /** scrypt 哈希（ADMIN_PASSWORD_HASH，格式 scrypt$salt$derived；deploy/admin/gen-admin-password.mjs 生成） */
  passwordHash: string;
  /** 会话 TTL（毫秒），默认 8 小时 */
  sessionTtlMs?: number;
}

export interface AdminSessionData {
  token: string;
  email: string;
}

interface AdminSessionEntry {
  email: string;
  /** performance.now() + TTL（单调时钟，防时钟跳变） */
  expiresAt: number;
}

export interface AdminAuthService {
  login(input: { email: string; password: string }): Promise<Result<AdminSessionData, CommonError>>;
  logout(token: string): Promise<Result<{ ok: true }, CommonError>>;
  validateToken(token: string): Promise<Result<{ email: string }, CommonError>>;
  getMe(email: string): Promise<Result<{ email: string }, CommonError>>;
}

export function hashAdminPassword(password: string): string {
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

export function createAdminAuthService(options: AdminAuthServiceOptions): AdminAuthService {
  const adminEmail = options.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(adminEmail)) {
    throw new Error('ADMIN_EMAIL 格式不合法');
  }
  if (typeof options.passwordHash !== 'string' || options.passwordHash.split('$').length !== 3) {
    throw new Error('ADMIN_PASSWORD_HASH 缺失或格式不合法（期望 scrypt$salt$derived）');
  }
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, AdminSessionEntry>();

  /** 惰性清理过期会话（登录/校验时触发，管理员数量极少，O(n) 可接受）。 */
  function pruneExpired(): void {
    const now = performance.now();
    for (const [key, entry] of sessions) {
      if (entry.expiresAt <= now) sessions.delete(key);
    }
  }

  return {
    async login(input) {
      pruneExpired();
      const email = input.email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email)) {
        return err(validationError('邮箱格式不正确', 'email'));
      }
      // 统一失败语义：邮箱不匹配（非管理员邮箱）也做等时比对，防响应时间枚举
      const passwordOk = email === adminEmail
        ? verifyPassword(input.password, options.passwordHash)
        : verifyPassword(input.password, hashAdminPassword('timing-equalization-dummy'));
      if (!passwordOk) {
        return err(permissionDenied('邮箱或密码错误'));
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(hashToken(token), { email: adminEmail, expiresAt: performance.now() + sessionTtlMs });
      return ok({ token, email: adminEmail });
    },

    async logout(token) {
      sessions.delete(hashToken(token)); // 幂等：不存在即 no-op
      return ok({ ok: true as const });
    },

    async validateToken(token) {
      const entry = sessions.get(hashToken(token));
      if (!entry) return err(permissionDenied('管理员会话无效或已过期'));
      if (entry.expiresAt <= performance.now()) {
        sessions.delete(hashToken(token));
        return err(permissionDenied('管理员会话已过期'));
      }
      return ok({ email: entry.email });
    },

    async getMe(email) {
      if (email !== adminEmail) return err(permissionDenied('管理员不存在'));
      return ok({ email });
    },
  };
}

/** 从 env 构建（挂载点调用）；ADMIN_EMAIL/ADMIN_PASSWORD_HASH 缺失即抛错（启动红线）。 */
export function createAdminAuthServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdminAuthService {
  if (!env.ADMIN_EMAIL) {
    throw new Error('ADMIN_EMAIL is required to enable the admin panel');
  }
  if (!env.ADMIN_PASSWORD_HASH) {
    throw new Error('ADMIN_PASSWORD_HASH is required to enable the admin panel');
  }
  return createAdminAuthService({
    email: env.ADMIN_EMAIL,
    passwordHash: env.ADMIN_PASSWORD_HASH,
  });
}
