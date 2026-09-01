import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createDatabaseConfirmableActionRegistry } from '../../../src/app/confirmation/database-confirmable-action-registry.js';
import { createFeedbackStatusActionExecutor } from '../../../src/app/confirmation/feedback-status-action-executor.js';
import { createFeedbackService } from '../../../src/features/feedback/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

// P29-W1：feedback.updateStatus executor 契约。
// 此文件同时充当 TDD 红灯（实现缺失时 registry.get 返回 INTERNAL_ERROR）与
// 实现落盘后的契约回归套件（source: agent-confirmed 显式审计、CAS、所有权、流转/sentAt 复检）。

const TEACHER_A = 'test-feedback-status-executor-a';
const TEACHER_B = 'test-feedback-status-executor-b';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createFeedback(status: 'draft' | 'reviewed' | 'sent' | 'archived' = 'reviewed', content = '内容') {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER_A, name: '测试学生', grade: '高一', source: 'test' },
  });
  const service = createFeedbackService({ prisma, cipher });
  const created = await service.createFeedback({
    teacherId: TEACHER_A,
    studentId: student.id,
    title: '待处理反馈',
    content,
    channel: 'wechat',
    parentName: '家长',
  });
  if (!created.ok) throw new Error(`fixture createFeedback failed: ${created.error.message}`);
  if (status !== 'draft') {
    await prisma.parentFeedback.update({ where: { id: created.value.id }, data: { status } });
  }
  return prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
}

function expectZeroEffects(feedbackId: string) {
  return {
    async statusUnchanged(status: string) {
      const row = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedbackId } });
      expect(row.status).toBe(status);
    },
    // 只断言 executor 的 update 审计（fixture createFeedback 会写一条合法 create 审计，
    // 不属于本切片的确认执行审计）。
    async noChangelog() {
      expect(await prisma.changeLog.count({
        where: { teacherId: TEACHER_A, targetId: feedbackId, action: 'update' },
      })).toBe(0);
    },
  };
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.changeLog.deleteMany();
  await prisma.parentFeedback.deleteMany();
  await prisma.student.deleteMany();
});

describe('P29-W1 feedback.updateStatus executor', () => {
  it('reviewed→sent 成功：状态更新 + 显式恰好一条 ChangeLog(source:agent-confirmed) + sentAt 归一化到同一毫秒 instant', async () => {
    const feedback = await createFeedback('reviewed');

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          sentAt: '2031-02-03T12:05:06.123456789+08:00',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({
      ok: true,
      value: { references: [{ type: 'ParentFeedback', id: feedback.id }] },
    });
    const persisted = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    expect(persisted.status).toBe('sent');
    // offset +08:00 与 9 位小数归一化到同一毫秒 instant（旧直接执行语义保留）
    expect(persisted.sentAtTs).toEqual(new Date('2031-02-03T04:05:06.123Z'));
    // 仅本 executor 的 update 审计恰好一条；fixture create 审计不计入
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER_A, targetId: feedback.id, action: 'update' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
    expect(logs[0].before).not.toBeNull();
    expect(logs[0].after).not.toBeNull();
  });

  it('缺省 sentAt 使用注入的 TrustedClock（旧语义：registry 注入的同一时钟）', async () => {
    const feedback = await createFeedback('reviewed');
    const token = new Date('2031-02-03T04:05:06.789Z');
    const clock: TrustedClock = { now: vi.fn().mockResolvedValue(ok(token)) };

    const result = await prisma.$transaction(async (tx) => {
      const executor = createFeedbackStatusActionExecutor({ tx, trustedClock: clock });
      return executor.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).sentAtTs).toEqual(token);
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  it('target 与 parameters 不一致拒绝且零修改', async () => {
    const feedback = await createFeedback('reviewed');

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: 'other-feedback-id',
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
    const effects = expectZeroEffects(feedback.id);
    await effects.statusUnchanged('reviewed');
    await effects.noChangelog();
  });

  it('expectedUpdatedAt CAS 冲突拒绝且零修改', async () => {
    const feedback = await createFeedback('reviewed');
    // 模拟并发更新：版本 token 前进
    await prisma.parentFeedback.update({
      where: { id: feedback.id },
      data: { updatedAtTs: new Date('2031-01-01T00:00:00.000Z') },
    });

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(), // 旧版本
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const effects = expectZeroEffects(feedback.id);
    await effects.statusUnchanged('reviewed');
    await effects.noChangelog();
  });

  it('跨 teacher 返回 NOT_FOUND 且零修改', async () => {
    const feedback = await createFeedback('reviewed');

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_B,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const effects = expectZeroEffects(feedback.id);
    await effects.statusUnchanged('reviewed');
    await effects.noChangelog();
  });

  it('状态流转非法在 executor 复检拒绝且零修改', async () => {
    const feedback = await createFeedback('reviewed'); // reviewed→draft 非法

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'draft',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' } });
    const effects = expectZeroEffects(feedback.id);
    await effects.statusUnchanged('reviewed');
    await effects.noChangelog();
  });

  it('sentAt 规则在 executor 复检拒绝且零修改', async () => {
    const feedback = await createFeedback('reviewed');

    // 非 sent 携带 sentAt → 拒绝（field: sentAt）
    const nonSent = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'archived',
          sentAt: '2031-02-03T04:05:06Z',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });
    expect(nonSent).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'sentAt' } });

    // sent + 非法 RFC3339 sentAt → 拒绝（parameters 结构不合法）
    const invalidSentAt = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('feedback.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          sentAt: '2031-02-03T04:05:06',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });
    expect(invalidSentAt).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });

    const effects = expectZeroEffects(feedback.id);
    await effects.statusUnchanged('reviewed');
    await effects.noChangelog();
  });

  it('reviewed→sent 透传 local moderation 与 logger（发送前审核语义保留）', async () => {
    const feedback = await createFeedback('reviewed', '请打死他');
    const moderation = {
      provider: 'local',
      moderateText: vi.fn().mockResolvedValue({
        verdict: 'review', labels: ['violence'], flagged: true, reasons: ['violence（暴力/威胁言论）'],
      }),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await prisma.$transaction(async (tx) => {
      const executor = createFeedbackStatusActionExecutor({ tx, moderation, logger });
      return executor.execute({
        teacherId: TEACHER_A,
        target: { type: 'ParentFeedback', id: feedback.id },
        parameters: {
          feedbackId: feedback.id,
          status: 'sent',
          expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
        },
      });
    });

    expect(result).toMatchObject({ ok: true });
    expect(moderation.moderateText).toHaveBeenCalledWith({ text: '待处理反馈\n请打死他', scene: 'feedback' });
    expect(logger.info).toHaveBeenCalledWith('feedback moderation flag', {
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      reasons: ['violence（暴力/威胁言论）'],
    });
    const persisted = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    expect(persisted.moderationFlagged).toBe(true);
    expect(persisted.moderationReasons).toEqual(['violence（暴力/威胁言论）']);
  });
});
