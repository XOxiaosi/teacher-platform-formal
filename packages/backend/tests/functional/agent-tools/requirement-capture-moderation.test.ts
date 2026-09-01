import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createMinimalToolRegistry } from '../../../src/app/tool-registration.js';
import { createLocalModerationAdapter } from '../../../src/shared/platform-services/index.js';
import { createLogger } from '../../../src/shared/logger/index.js';

/**
 * P15 t2（agent 工具路径 moderation 透传，P14 t2 遗留）功能测试：
 * requirements.capture 工具写库前调 moderation adapter（本地规则先行，moderateWithLocalRules 引擎）
 * → flagged 时**不阻断写库**（review 心智）+ 审计日志 msg:'moderation flag' actor=agent
 * + 预计算结果透传 service 落 additive 列（moderationFlagged/moderationReasons）；
 * 未配置 moderation → 零影响（基线）；正常文本 → 无 flag。
 */

const prisma = new PrismaClient();
const createdIds: string[] = [];
const createdTeacherIds: string[] = [];

async function ensureTeacher(id: string): Promise<void> {
  const existing = await prisma.teacherRegistry.findUnique({ where: { id } });
  if (existing) return;
  await prisma.teacherRegistry.create({
    data: { id, email: `${id}@example.com`, passwordHash: 'test-hash', displayName: id },
  });
  createdTeacherIds.push(id);
}

function uniqueQuote(prefix = 'req-tool-mod'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function track(id: string): void {
  createdIds.push(id);
}

afterAll(async () => {
  await prisma.userRequirement.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

/** 捕获式 logger：把每一行结构化日志 JSON 收进数组供断言。 */
function createCapturingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  return { lines, logger };
}

function flagLine(lines: string[]): Record<string, unknown> | undefined {
  const line = lines.find((item) => item.includes('"msg":"moderation flag"'));
  if (!line) return undefined;
  return JSON.parse(line) as Record<string, unknown>;
}

describe('requirements.capture 工具 moderation 透传（P15 t2）', () => {
  it('agent 调 capture 含敏感词 → 写库成功（不阻断）+ 审计 msg=moderation flag actor=agent + additive 列落库', async () => {
    await ensureTeacher('teacher-tool-mod-hit');
    const { lines, logger } = createCapturingLogger();
    const registry = createMinimalToolRegistry({
      prisma,
      moderation: createLocalModerationAdapter(),
      logger,
    });

    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: `打死你这个骗子，免费领取课程加微信 ${uniqueQuote()}`, category: 'feature' },
      { teacherId: 'teacher-tool-mod-hit' },
    );
    // review 心智：命中不阻断写库
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { requirementId: string };
    track(value.requirementId);

    // 审计日志：msg + actor=agent（与 HTTP 路径 actor=teacherId 区分）+ requirementId + reasons
    const audit = flagLine(lines);
    expect(audit).toBeDefined();
    expect(audit!.actor).toBe('agent');
    expect(audit!.requirementId).toBe(value.requirementId);
    expect(Array.isArray(audit!.reasons)).toBe(true);
    expect((audit!.reasons as string[]).length).toBeGreaterThan(0);
    expect((audit!.reasons as string[]).some((r) => r.startsWith('violence'))).toBe(true);
    expect((audit!.reasons as string[]).some((r) => r.startsWith('ad'))).toBe(true);

    // additive 列持久化
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: value.requirementId } });
    expect(persisted.moderationFlagged).toBe(true);
    expect(Array.isArray(persisted.moderationReasons)).toBe(true);
    expect((persisted.moderationReasons as string[]).length).toBeGreaterThan(0);
  });

  it('agent 调 capture 正常文本 → 无 flag（无审计日志、additive 列 null）', async () => {
    await ensureTeacher('teacher-tool-mod-pass');
    const { lines, logger } = createCapturingLogger();
    const registry = createMinimalToolRegistry({
      prisma,
      moderation: createLocalModerationAdapter(),
      logger,
    });

    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: `今天的作业是完成第三单元练习 ${uniqueQuote()}`, category: 'improvement' },
      { teacherId: 'teacher-tool-mod-pass' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { requirementId: string };
    track(value.requirementId);

    expect(flagLine(lines)).toBeUndefined();
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: value.requirementId } });
    expect(persisted.moderationFlagged).toBeNull();
    expect(persisted.moderationReasons).toBeNull();
  });

  it('未配置 moderation（registry 无 moderation 选项）→ 零影响：写库正常、无审计日志、无标记列', async () => {
    await ensureTeacher('teacher-tool-mod-none');
    const { lines, logger } = createCapturingLogger();
    const registry = createMinimalToolRegistry({
      prisma,
      logger, // 有 logger 但无 moderation：验证 moderation 未装配时完全不触发
    });

    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: `打死你这个骗子 ${uniqueQuote()}`, category: 'bug_report' },
      { teacherId: 'teacher-tool-mod-none' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { requirementId: string };
    track(value.requirementId);

    expect(flagLine(lines)).toBeUndefined();
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: value.requirementId } });
    expect(persisted.moderationFlagged).toBeNull();
    expect(persisted.moderationReasons).toBeNull();
  });

  it('moderation adapter 异常 → 不阻断写库（warn 审计 + 记录正常创建，零破坏）', async () => {
    await ensureTeacher('teacher-tool-mod-err');
    const { lines, logger } = createCapturingLogger();
    const registry = createMinimalToolRegistry({
      prisma,
      moderation: {
        provider: 'boom',
        async moderateText() {
          throw new Error('adapter exploded');
        },
      },
      logger,
    });

    const result = await registry.execute(
      'requirements.capture',
      { verbatimQuote: `作业反馈 ${uniqueQuote()}`, category: 'feature' },
      { teacherId: 'teacher-tool-mod-err' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { requirementId: string };
    track(value.requirementId);

    // 无 moderation flag 审计；有 moderation check failed warn（actor=agent）
    expect(flagLine(lines)).toBeUndefined();
    expect(lines.some((l) => l.includes('"msg":"moderation check failed"'))).toBe(true);
    expect(lines.some((l) => l.includes('"actor":"agent"'))).toBe(true);
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: value.requirementId } });
    expect(persisted.moderationFlagged).toBeNull();
  });
});
