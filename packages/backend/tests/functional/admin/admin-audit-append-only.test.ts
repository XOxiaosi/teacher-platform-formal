import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAdminAuthService,
  hashAdminPassword,
} from '../../../src/features/admin/index.js';
import { recordAdminAction } from '../../../src/features/admin/audit.js';

/**
 * QA2 验收（t81）：后台面板线边界测试补充。
 *
 * 1. 审计只 append：AdminAuditLog 只增不改——源码断言 audit.ts 无 update/delete
 *    路径（防未来引入修改审计记录的路径，破坏追溯完整性）。
 * 2. adminToken 会话过期（重启失效语义）：内存 Map 会话——新实例不认旧 token
 *    （模拟进程重启，token 需重登）。
 * 3. 失败动作记 *.failed：日志层 action 追加断言（已由 admin-audit-db 覆盖 DB 层，
 *    此处补纯日志层 recordAdminAction 断言）。
 */

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-secret-123';
const ADMIN_HASH = hashAdminPassword(ADMIN_PASSWORD);

describe('审计只 append（AdminAuditLog 无修改路径）', () => {
  it('audit.ts 源码不含 adminAuditLog.update / adminAuditLog.delete 调用', () => {
    const auditSrc = readFileSync(
      resolve(process.cwd(), 'src/features/admin/audit.ts'),
      'utf8',
    );
    // append-only 纪律：审计表只允许 create（追加），禁止 update/delete
    expect(auditSrc).toContain('adminAuditLog.create');
    expect(auditSrc).not.toMatch(/adminAuditLog\.(update|delete|upsert|updateMany|deleteMany)/);
    // 实现注释明确纪律
    expect(auditSrc).toContain('append-only');
    expect(auditSrc).toContain('不 update/delete');
  });

  it('审计 action 失败追加 .failed（纯日志层）', () => {
    const lines: string[] = [];
    const logger = { info: (msg: string, fields: unknown) => lines.push(JSON.stringify({ msg, ...(fields as object) })) } as never;

    recordAdminAction(logger as never, {
      actor: ADMIN_EMAIL,
      action: 'teacher.disable',
      objectType: 'teacher',
      objectId: 'teacher-1',
    });
    expect(lines[0]).toContain('"action":"teacher.disable"');

    lines.length = 0;
    recordAdminAction(logger as never, {
      actor: ADMIN_EMAIL,
      action: 'backup.run',
      objectType: 'backup',
      error: new Error('disk full'),
    });
    expect(lines[0]).toContain('"action":"backup.run.failed"');
    expect(lines[0]).toContain('"error"');
  });
});

describe('adminToken 会话过期（内存会话重启失效语义）', () => {
  it('同一实例：短 TTL 后 token 过期 → validateToken 失败', async () => {
    const service = createAdminAuthService({
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_HASH,
      sessionTtlMs: 60,
    });
    const login = await service.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const token = login.value.token;

    // TTL 内有效
    const valid = await service.validateToken(token);
    expect(valid.ok).toBe(true);

    // 等 TTL 过期（单调时钟）
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    const expired = await service.validateToken(token);
    expect(expired.ok).toBe(false);
  });

  it('重启失效语义：新实例（模拟进程重启）不认旧 token → 需重登', async () => {
    // 实例 A：登录拿 token
    const instanceA = createAdminAuthService({
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_HASH,
      sessionTtlMs: 8 * 60 * 60 * 1000,
    });
    const login = await instanceA.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const token = login.value.token;

    // 实例 B：全新内存 Map（模拟进程重启）——不认旧 token
    const instanceB = createAdminAuthService({
      email: ADMIN_EMAIL,
      passwordHash: ADMIN_HASH,
      sessionTtlMs: 8 * 60 * 60 * 1000,
    });
    const afterRestart = await instanceB.validateToken(token);
    expect(afterRestart.ok).toBe(false);
    if (afterRestart.ok) return;
    expect(afterRestart.error.code).toBe('PERMISSION_DENIED');

    // 重登成功（重启后需重新登录）
    const relogin = await instanceB.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(relogin.ok).toBe(true);
  });
});
