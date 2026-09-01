import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { PrismaClient } from '@prisma/client';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

// P8 phase-3 批1：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

// Phase 3.5-A: 红灯测试
// createMinimalToolRegistry 当前不包含 feedback 基础工具。
// 本测试锁定 Phase 3.5 基础工具注册契约，实现将在 Phase 3.5-B 完成。

let createMinimalToolRegistry: unknown;
try {
  const mod = await import('../../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

function requireRegistryFactory() {
  if (!createMinimalToolRegistry) {
    throw new Error('createMinimalToolRegistry export is missing');
  }
  return createMinimalToolRegistry as (options: {
    prisma: PrismaClient;
    trustedClock?: TrustedClock;
    moderation?: { provider: string; moderateText: ReturnType<typeof vi.fn> };
    logger?: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  }) => {
    list(): Array<{ name: string; confirmation?: 'none' | 'required' }>;
    execute(name: string, args: unknown, context: { teacherId: string }): Promise<{ ok: boolean; value?: unknown; error?: { code: string; field?: string } }>;
  };
}

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-feedback-tools-a';
const TEACHER_B = 'test-teacher-feedback-tools-b';

async function cleanup() {
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  try {
    await prisma.feedbackEvidence.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  } catch {
    // ignore before table is pushed
  }
  try {
    await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  } catch {
    // ignore before table is pushed
  }
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('feedback 工具注册契约（Phase 3.5-A 红灯）', () => {
  it('registry.list 包含 feedback.create / feedback.list / feedback.updateStatus', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('feedback.create');
    expect(toolNames).toContain('feedback.list');
    expect(toolNames).toContain('feedback.updateStatus');
  });

  it('feedback.create 调用真实 feedback service，创建当前 teacher 家长反馈', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('feedback.create', {
      studentId: student.id,
      title: '张三学习反馈',
      content: '课堂状态稳定。',
      channel: 'wechat',
      parentName: '张三妈妈',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const feedbacks = await prisma.parentFeedback.findMany({ where: { teacherId: TEACHER_A } });
    expect(feedbacks).toHaveLength(1);
    expect(feedbacks[0].studentId).toBe(student.id);
    // P8 phase-3 批1：title 落库为密文，解密后为原文
    expect(feedbacks[0].title).not.toBe('张三学习反馈');
    expect(cipher.decrypt(feedbacks[0].title)).toBe('张三学习反馈');
    expect(feedbacks[0].status).toBe('draft');
  });

  it('feedback.create 拒绝关联其他 teacher 的学生', async () => {
    const otherStudent = await createStudentFixture(TEACHER_B, '其他老师学生');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('feedback.create', {
      studentId: otherStudent.id,
      title: '跨老师反馈',
      content: '不应创建',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('feedback.create accepted another teacher student');
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('feedback.list 只返回当前 teacher 数据，不泄露其他 teacher', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '学生A');
    const studentB = await createStudentFixture(TEACHER_B, '学生B');
    await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: studentA.id, title: 'A1', content: 'A 内容 1' },
    });
    await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: studentA.id, title: 'A2', content: 'A 内容 2', status: 'reviewed' },
    });
    await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_B, studentId: studentB.id, title: 'B1', content: 'B 秘密内容' },
    });

    const registry = requireRegistryFactory()({ prisma });
    const result = await registry.execute('feedback.list', { status: 'reviewed' }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value as { items: Array<{ teacherId: string; title: string; status: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].teacherId).toBe(TEACHER_A);
    expect(data.items[0].title).toBe('A2');
    expect(JSON.stringify(data)).not.toContain('B 秘密内容');
  });

  it('P29-W1 feedback.updateStatus 声明 required，直接执行 fail-closed 且零状态/审计写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '确认前学生');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '待确认', content: '不得直接发送', status: 'reviewed' },
    });
    const registry = requireRegistryFactory()({ prisma });
    const definition = registry.list().find((tool) => tool.name === 'feedback.updateStatus');

    expect(definition?.confirmation).toBe('required');
    const result = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id,
      status: 'sent',
    }, { teacherId: TEACHER_A });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetId: feedback.id } })).toBe(0);
  });

  // ===== P29-W1：旧直接执行成功语义改写到 Gateway/确认 executor/端到端 =====
  // 原「只能更新当前 teacher / 跨 teacher NOT_FOUND」「非法 status」「RFC3339 sentAt
  // 原样写入」「拒绝非法 sentAt」「缺省 sentAt 使用 TrustedClock」「moderation/logger
  // 透传」等直接执行成功测试，按冻结契约迁往：
  //   - tests/functional/confirmation/feedback-status-confirmation-gateway.test.ts
  //   - tests/functional/confirmation/feedback-status-action-executor.test.ts
  //   - tests/e2e/agent-feedback-status-confirmation-workflow.test.ts
  //   - tests/functional/feedback/feedback-status-audit-atomicity.test.ts
  // 本文件保留注册层契约：任何 direct execute 一律 fail-closed（confirmation 字段），
  // 无论合法/非法参数、跨 teacher 或注入 clock/moderation，均零状态与零审计写入。

  it('feedback.updateStatus 跨 teacher 也 fail-closed（confirmation），不做任何状态写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '跨老师红灯');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '待审核', content: '内容' },
    });
    const registry = requireRegistryFactory()({ prisma });

    const crossed = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id,
      status: 'sent',
    }, { teacherId: TEACHER_B });
    expect(crossed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('draft');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetId: feedback.id } })).toBe(0);
  });

  it('feedback.updateStatus 非法 status 也 fail-closed（confirmation），不触发状态校验', async () => {
    const student = await createStudentFixture(TEACHER_A, '非法状态红灯');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '状态测试', content: '内容' },
    });
    const registry = requireRegistryFactory()({ prisma });

    const listResult = await registry.execute('feedback.list', { status: 'invalid' }, { teacherId: TEACHER_A });
    expect(listResult.ok).toBe(false);
    if (listResult.ok) return;
    expect(listResult.error?.code).toBe('VALIDATION_ERROR');
    expect(listResult.error?.field).toBe('status');

    const updateResult = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id,
      status: 'invalid',
    }, { teacherId: TEACHER_A });
    expect(updateResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('draft');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetId: feedback.id } })).toBe(0);
  });

  it('feedback.updateStatus 任意 sentAt（合法/非法/非 sent 携带）都 fail-closed 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '时间红灯');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '待发送', content: '内容', status: 'reviewed' },
    });
    const registry = requireRegistryFactory()({ prisma });

    for (const sentAt of ['2031-02-03T04:05:06Z', '2031-02-03T04:05:06', 123, '2031-02-03T12:05:06.123456789+08:00']) {
      const result = await registry.execute('feedback.updateStatus', {
        feedbackId: feedback.id,
        status: 'sent',
        sentAt,
      }, { teacherId: TEACHER_A });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
      });
    }
    const nonSent = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id,
      status: 'reviewed',
      sentAt: '2031-02-03T04:05:06Z',
    }, { teacherId: TEACHER_A });
    expect(nonSent).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetId: feedback.id } })).toBe(0);
  });

  it('feedback.updateStatus direct fail-closed 不调用注入的 TrustedClock', async () => {
    const student = await createStudentFixture(TEACHER_A, '时钟红灯');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '待发送', content: '内容', status: 'reviewed' },
    });
    const clock = { now: vi.fn().mockResolvedValue(ok(new Date('2040-01-01T00:00:00Z'))) };
    const registry = requireRegistryFactory()({ prisma, trustedClock: clock });

    const result = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id,
      status: 'sent',
    }, { teacherId: TEACHER_A });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
  });

  it('feedback.updateStatus direct fail-closed 不调用 moderation 与 logger', async () => {
    const student = await createStudentFixture(TEACHER_A, '审核红灯');
    const feedback = await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_A, studentId: student.id, title: '待发送', content: '请打死他', status: 'reviewed' },
    });
    const moderation = {
      provider: 'local',
      moderateText: vi.fn().mockResolvedValue({
        verdict: 'review', labels: ['violence'], flagged: true, reasons: ['violence（暴力/威胁言论）'],
      }),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const registry = requireRegistryFactory()({ prisma, moderation, logger });

    const result = await registry.execute('feedback.updateStatus', {
      feedbackId: feedback.id, status: 'sent',
    }, { teacherId: TEACHER_A });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'confirmation' }),
    });
    expect(moderation.moderateText).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_A, targetId: feedback.id } })).toBe(0);
  });

  it('仍不注册 feedback.send / feedback.delete / feedback.generateDraft', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).not.toContain('feedback.send');
    expect(toolNames).not.toContain('feedback.delete');
    expect(toolNames).not.toContain('feedback.generateDraft');
  });

  // ===== D40 Phase 5: feedback.create 携带 evidence 快照 =====

  it('feedback.create 带 evidence 透传给 service，evidence 落库成功', async () => {
    const student = await createStudentFixture(TEACHER_A, '工具证据学生');
    const registry = requireRegistryFactory()({ prisma });

    const evidence = [
      {
        id: 'rec-tool-1',
        type: 'assessment',
        occurredAt: '2026-01-15T10:00:00Z',
        category: '月考',
        summary: '数学月考成绩优秀',
        examName: '高一上学期第一次月考',
        subject: '数学',
        score: 92,
        fullScore: 100,
        previousScore: 85,
        parentConcerns: ['解题步骤不规范'],
        followUps: ['加强错题本练习'],
      },
    ];

    const result = await registry.execute('feedback.create', {
      studentId: student.id,
      title: '带证据工具反馈',
      content: '内容',
      evidence,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-02-01T00:00:00Z',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 验证 feedback + snapshot + evidence 都落库
    const feedbacks = await prisma.parentFeedback.findMany({ where: { teacherId: TEACHER_A } });
    expect(feedbacks).toHaveLength(1);

    const snapshot = await prisma.feedbackContextSnapshot.findFirst({
      where: { feedbackId: feedbacks[0].id, teacherId: TEACHER_A },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.windowStartTs).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(snapshot?.windowEndTs).toEqual(new Date('2026-02-01T00:00:00Z'));

    const records = await prisma.feedbackEvidence.findMany({
      where: { teacherId: TEACHER_A },
      orderBy: { sortOrder: 'asc' },
    });
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('assessment');
    expect(records[0].recordId).toBe('rec-tool-1');
    expect(records[0].score).toBe(92);
    // P8 phase-3 批5：parentConcerns 落库为密文，解密后断言
    expect(cipher.decryptJson<unknown>(records[0].parentConcerns as unknown as string)).toEqual(['解题步骤不规范']);
  });

  it('feedback.create 不带 evidence 时行为不变（不建快照）', async () => {
    const student = await createStudentFixture(TEACHER_A, '工具无证据学生');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('feedback.create', {
      studentId: student.id,
      title: '无证据工具反馈',
      content: '内容',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshotCount = await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_A } });
    expect(snapshotCount).toBe(0);
  });

  it('feedback.create evidence 非数组返回 VALIDATION_ERROR', async () => {
    const student = await createStudentFixture(TEACHER_A, '工具坏evidence');
    const registry = requireRegistryFactory()({ prisma });

    const result = await registry.execute('feedback.create', {
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: 'not-array',
    }, { teacherId: TEACHER_A });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.field).toBe('evidence');
  });
});
