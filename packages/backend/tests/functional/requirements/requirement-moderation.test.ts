import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createRequirementService } from '../../../src/features/requirements/index.js';
import { createLocalModerationAdapter } from '../../../src/shared/platform-services/index.js';
import { createLogger } from '../../../src/shared/logger/index.js';

/**
 * P14 D 切片（moderation 接线 UserRequirement，t2）功能测试：
 * createRequirement 写库前调 moderation adapter（本地规则先行）→ flagged 时**不阻断写库**
 * （review 心智）+ 结构化日志审计（msg:'moderation flag', actor, requirementId, reasons）
 * + additive 列（moderationFlagged/moderationReasons）；未配置 moderation → 零影响（基线）。
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

function uniqueQuote(prefix = 'req-mod'): string {
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

describe('RequirementService moderation 接线（P14 D 切片 · t2）', () => {
  it('含敏感词提交 → 写库成功（不阻断）+ 审计日志 msg=moderation flag 含 reasons + additive 列落库', async () => {
    await ensureTeacher('teacher-mod-hit');
    const { lines, logger } = createCapturingLogger();
    const service = createRequirementService({
      getClient: async () => prisma,
      moderation: createLocalModerationAdapter(),
      logger,
    });

    const result = await service.createRequirement({
      teacherId: 'teacher-mod-hit',
      verbatimQuote: `打死你这个骗子，免费领取课程加微信 ${uniqueQuote()}`,
      category: 'feature',
    });
    // review 心智：命中不阻断写库
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    track(result.value.id);

    // 审计日志：msg + actor + requirementId + reasons
    const audit = flagLine(lines);
    expect(audit).toBeDefined();
    expect(audit!.actor).toBe('teacher-mod-hit');
    expect(audit!.requirementId).toBe(result.value.id);
    expect(Array.isArray(audit!.reasons)).toBe(true);
    expect((audit!.reasons as string[]).length).toBeGreaterThan(0);
    expect((audit!.reasons as string[]).some((r) => r.startsWith('violence'))).toBe(true);
    expect((audit!.reasons as string[]).some((r) => r.startsWith('ad'))).toBe(true);

    // additive 列持久化
    expect(result.value.moderationFlagged).toBe(true);
    expect(result.value.moderationReasons).not.toBeNull();
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.moderationFlagged).toBe(true);
    expect(Array.isArray(persisted.moderationReasons)).toBe(true);
    expect((persisted.moderationReasons as string[]).length).toBeGreaterThan(0);
  });

  it('正常文本 → 无 flag（无审计日志、additive 列 null）', async () => {
    await ensureTeacher('teacher-mod-pass');
    const { lines, logger } = createCapturingLogger();
    const service = createRequirementService({
      getClient: async () => prisma,
      moderation: createLocalModerationAdapter(),
      logger,
    });

    const result = await service.createRequirement({
      teacherId: 'teacher-mod-pass',
      verbatimQuote: `今天的作业是完成第三单元练习 ${uniqueQuote()}`,
      category: 'improvement',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    track(result.value.id);

    expect(flagLine(lines)).toBeUndefined();
    expect(result.value.moderationFlagged).toBeNull();
    expect(result.value.moderationReasons).toBeNull();
    const persisted = await prisma.userRequirement.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(persisted.moderationFlagged).toBeNull();
    expect(persisted.moderationReasons).toBeNull();
  });

  it('未配置 moderation（service 无 moderation 选项）→ 零影响：写库正常、无审计日志、无标记列', async () => {
    await ensureTeacher('teacher-mod-none');
    const { lines, logger } = createCapturingLogger();
    const service = createRequirementService({
      getClient: async () => prisma,
      logger, // 有 logger 但无 moderation：验证 moderation 未装配时完全不触发
    });

    const result = await service.createRequirement({
      teacherId: 'teacher-mod-none',
      verbatimQuote: `打死你这个骗子 ${uniqueQuote()}`,
      category: 'bug_report',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    track(result.value.id);

    expect(flagLine(lines)).toBeUndefined();
    expect(result.value.moderationFlagged).toBeNull();
    expect(result.value.moderationReasons).toBeNull();
  });

  it('moderation adapter 异常 → 不阻断写库（warn 审计 + 记录正常创建，零破坏）', async () => {
    await ensureTeacher('teacher-mod-err');
    const { lines, logger } = createCapturingLogger();
    const service = createRequirementService({
      getClient: async () => prisma,
      moderation: {
        provider: 'boom',
        async moderateText() {
          throw new Error('adapter exploded');
        },
      },
      logger,
    });

    const result = await service.createRequirement({
      teacherId: 'teacher-mod-err',
      verbatimQuote: `作业反馈 ${uniqueQuote()}`,
      category: 'feature',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    track(result.value.id);

    // 无 moderation flag 审计；有 moderation check failed warn
    expect(flagLine(lines)).toBeUndefined();
    expect(lines.some((l) => l.includes('"msg":"moderation check failed"'))).toBe(true);
    expect(result.value.moderationFlagged).toBeNull();
  });

  it('白名单防误杀经 adapter 生效：习语不 flag（review 心智：宁可漏标不可误杀）', async () => {
    await ensureTeacher('teacher-mod-wl');
    const { lines, logger } = createCapturingLogger();
    const service = createRequirementService({
      getClient: async () => prisma,
      moderation: createLocalModerationAdapter(),
      logger,
    });

    const result = await service.createRequirement({
      teacherId: 'teacher-mod-wl',
      verbatimQuote: `这件事打死也不说 ${uniqueQuote()}`,
      category: 'other',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    track(result.value.id);

    expect(flagLine(lines)).toBeUndefined();
    expect(result.value.moderationFlagged).toBeNull();
  });
});
