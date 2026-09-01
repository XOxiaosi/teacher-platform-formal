import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import type { ParentFeedbackData } from '../../../src/features/feedback/types.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createFieldCipher, encryptFieldValue, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import type { Logger } from '../../../src/shared/logger/index.js';
import type { ModerationAdapter } from '../../../src/shared/platform-services/index.js';

// P8 phase-3 批5：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

// Phase 3.3-A: 红灯测试
// feedback service 当前仍是 planned stub。
// 本测试锁定 Phase 3.3 CRUD 与状态机契约，实现将在 Phase 3.3-B 完成。

const prisma = new PrismaClient();
const TEACHER_A = 'test-teacher-feedback-a';
const TEACHER_B = 'test-teacher-feedback-b';

function createService(
  trustedClock?: TrustedClock,
  moderation?: ModerationAdapter,
  logger?: Logger,
) {
  return createFeedbackService({ prisma, trustedClock, moderation, logger });
}

function moderationAdapter(
  provider: string,
  moderateText: ModerationAdapter['moderateText'],
): ModerationAdapter {
  return { provider, moderateText };
}

function loggerSpy(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function fixedClock(value = new Date('2031-02-03T04:05:06.789Z')): TrustedClock & { now: ReturnType<typeof vi.fn> } {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}

async function createStatusFixture(status: 'draft' | 'reviewed' | 'sent' | 'archived', sentAt: Date | null = null) {
  const student = await createStudentFixture(TEACHER_A, `状态夹具-${status}`);
  return prisma.parentFeedback.create({
    data: {
      teacherId: TEACHER_A,
      studentId: student.id,
      title: `${status}反馈`,
      content: '状态测试内容',
      status,
      sentAtTs: sentAt,
    },
  });
}

async function cleanup() {
  // Phase 3.3-A 红灯阶段，数据库可能尚未 db push 出 ParentFeedback 表；
  // cleanup 不应让红灯退化为 schema 环境失败。实现阶段同步数据库后该清理会真实生效。
  try {
    await prisma.feedbackEvidence.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before table is pushed
  }
  try {
    await prisma.feedbackContextSnapshot.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before table is pushed
  }
  try {
    await prisma.parentFeedback.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before ParentFeedback table is pushed to test database
  }

  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: {
      teacherId,
      name,
      grade: '高一',
      source: 'test',
    },
  });
}

async function createLessonFixture(teacherId: string, studentId: string) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId,
      type: 'lesson',
      title: '家长反馈关联课程',
      scheduledStartTs: new Date('2026-09-01T10:00:00Z'),
      scheduledEndTs: new Date('2026-09-01T11:30:00Z'),
    },
  });

  return prisma.lesson.create({
    data: {
      teacherId,
      studentId,
      scheduleId: schedule.id,
      dateTs: new Date('2026-09-01T10:00:00Z'),
      status: 'attended',
      progress: '完成牛顿第二定律复习',
    },
  });
}

async function createFeedbackOrThrow(input: {
  teacherId: string;
  studentId: string;
  lessonId?: string;
  title: string;
  content: string;
  channel?: string;
  parentName?: string;
}): Promise<ParentFeedbackData> {
  const result = await createService().createFeedback(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('feedbackService.createFeedback', () => {
  it('创建 draft 家长反馈，保存学生、课程、渠道与家长姓名', async () => {
    const student = await createStudentFixture(TEACHER_A, '张三');
    const lesson = await createLessonFixture(TEACHER_A, student.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      lessonId: lesson.id,
      title: '张三本周学习反馈',
      content: '课堂状态稳定，力学计算准确率提升。',
      channel: 'wechat',
      parentName: '张三妈妈',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teacherId).toBe(TEACHER_A);
    expect(result.value.studentId).toBe(student.id);
    expect(result.value.lessonId).toBe(lesson.id);
    expect(result.value.title).toBe('张三本周学习反馈');
    expect(result.value.content).toBe('课堂状态稳定，力学计算准确率提升。');
    expect(result.value.status).toBe('draft');
    expect(result.value.channel).toBe('wechat');
    expect(result.value.parentName).toBe('张三妈妈');
    expect(result.value.sentAt).toBeNull();
  });

  it('title 或 content 为空返回 VALIDATION_ERROR', async () => {
    const student = await createStudentFixture(TEACHER_A, '李四');

    const titleResult = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '',
      content: '有效内容',
    });
    expect(titleResult.ok).toBe(false);
    if (titleResult.ok) return;
    expect(titleResult.error.code).toBe('VALIDATION_ERROR');
    expect(titleResult.error.field).toBe('title');

    const contentResult = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '有效标题',
      content: '',
    });
    expect(contentResult.ok).toBe(false);
    if (contentResult.ok) return;
    expect(contentResult.error.code).toBe('VALIDATION_ERROR');
    expect(contentResult.error.field).toBe('content');
  });

  it('拒绝关联其他 teacher 的学生，且零写入', async () => {
    const otherStudent = await createStudentFixture(TEACHER_B, '其他老师学生');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: otherStudent.id,
      title: '跨老师学生反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '学生不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('拒绝关联其他 teacher 的课次，且零写入', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '当前老师学生');
    const studentB = await createStudentFixture(TEACHER_B, '其他老师学生');
    const otherLesson = await createLessonFixture(TEACHER_B, studentB.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      lessonId: otherLesson.id,
      title: '跨老师课次反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '课次不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('拒绝 lesson 与 student 不一致的反馈，且零写入', async () => {
    const selectedStudent = await createStudentFixture(TEACHER_A, '被选择学生');
    const lessonStudent = await createStudentFixture(TEACHER_A, '课次所属学生');
    const lesson = await createLessonFixture(TEACHER_A, lessonStudent.id);

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: selectedStudent.id,
      lessonId: lesson.id,
      title: '错配课次反馈',
      content: '不应创建',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(expect.objectContaining({ code: 'NOT_FOUND', message: '课次不存在' }));
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });
});

describe('feedbackService.getFeedback', () => {
  it('按 teacherId + feedbackId 查询自己的反馈', async () => {
    const student = await createStudentFixture(TEACHER_A, '王五');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '查询反馈',
      content: '查询内容',
    });

    const result = await createService().getFeedback({ teacherId: TEACHER_A, feedbackId: feedback.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(feedback.id);
    expect(result.value.title).toBe('查询反馈');
  });

  it('不存在或跨 teacher 查询返回 NOT_FOUND', async () => {
    const student = await createStudentFixture(TEACHER_A, '赵六');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: 'A 的反馈',
      content: 'A 的内容',
    });

    const missing = await createService().getFeedback({ teacherId: TEACHER_A, feedbackId: 'nonexistent-id' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await createService().getFeedback({ teacherId: TEACHER_B, feedbackId: feedback.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('feedbackService.listFeedbacks', () => {
  it('只列出当前 teacher 的反馈，支持 studentId 与 status 过滤', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '学生A');
    const studentB = await createStudentFixture(TEACHER_B, '学生B');

    const feedbackA1 = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      title: 'A draft',
      content: 'A draft content',
    });
    await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      title: 'A reviewed',
      content: 'A reviewed content',
    });
    await createFeedbackOrThrow({
      teacherId: TEACHER_B,
      studentId: studentB.id,
      title: 'B draft',
      content: 'B draft content',
    });

    await createService().updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: feedbackA1.id, status: 'reviewed' });

    const result = await createService().listFeedbacks({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      status: 'reviewed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].teacherId).toBe(TEACHER_A);
    expect(result.value.items[0].studentId).toBe(studentA.id);
    expect(result.value.items[0].status).toBe('reviewed');
  });
});

describe('feedbackService.updateFeedbackContent', () => {
  it('更新 title/content，返回更新后的反馈', async () => {
    const student = await createStudentFixture(TEACHER_A, '钱七');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      title: '新标题',
      content: '新内容',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('新标题');
    expect(result.value.content).toBe('新内容');
  });

  it.each(['sent', 'archived'] as const)('%s 后拒绝内容编辑，避免出站审核投影过期', async (status) => {
    const feedback = await createStatusFixture(status, status === 'sent' ? new Date('2030-01-01T00:00:00Z') : null);
    const result = await createService().updateFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, title: '终态后修改',
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'status' }) });
  });

  it('空 title/content、无更新字段、不存在或跨 teacher 返回对应错误', async () => {
    const student = await createStudentFixture(TEACHER_A, '孙八');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '原标题',
      content: '原内容',
    });

    const emptyTitle = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      title: '',
    });
    expect(emptyTitle.ok).toBe(false);
    if (emptyTitle.ok) return;
    expect(emptyTitle.error.code).toBe('VALIDATION_ERROR');
    expect(emptyTitle.error.field).toBe('title');

    const emptyContent = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      content: '',
    });
    expect(emptyContent.ok).toBe(false);
    if (emptyContent.ok) return;
    expect(emptyContent.error.code).toBe('VALIDATION_ERROR');
    expect(emptyContent.error.field).toBe('content');

    const noFields = await createService().updateFeedbackContent({ teacherId: TEACHER_A, feedbackId: feedback.id });
    expect(noFields.ok).toBe(false);
    if (noFields.ok) return;
    expect(noFields.error.code).toBe('VALIDATION_ERROR');

    const missing = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: 'nonexistent-id',
      title: '新标题',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await createService().updateFeedbackContent({
      teacherId: TEACHER_B,
      feedbackId: feedback.id,
      title: '跨老师修改',
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('feedbackService.updateFeedbackStatus', () => {
  it('draft -> reviewed -> sent -> archived 成功，sent 写入 sentAt', async () => {
    const student = await createStudentFixture(TEACHER_A, '周九');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '状态反馈',
      content: '状态内容',
    });

    const reviewed = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'reviewed',
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.status).toBe('reviewed');

    const sentAt = new Date('2026-10-01T08:00:00Z');
    const sent = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
      sentAt: '2026-10-01T08:00:00Z',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.status).toBe('sent');
    expect(sent.value.sentAt).toEqual(sentAt);

    const archived = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'archived',
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.status).toBe('archived');
  });

  it('非法状态流转、非法 status、不存在或跨 teacher 返回对应错误', async () => {
    const student = await createStudentFixture(TEACHER_A, '吴十');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '状态反馈',
      content: '状态内容',
    });

    await createService().updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: feedback.id, status: 'reviewed' });
    await createService().updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent' });

    const backToDraft = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'draft',
    });
    expect(backToDraft.ok).toBe(false);
    if (backToDraft.ok) return;
    expect(backToDraft.error.code).toBe('VALIDATION_ERROR');
    expect(backToDraft.error.field).toBe('status');

    const invalidStatus = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'invalid' as never,
    });
    expect(invalidStatus.ok).toBe(false);
    if (invalidStatus.ok) return;
    expect(invalidStatus.error.code).toBe('VALIDATION_ERROR');
    expect(invalidStatus.error.field).toBe('status');

    const missing = await createService().updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: 'nonexistent-id',
      status: 'reviewed',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await createService().updateFeedbackStatus({
      teacherId: TEACHER_B,
      feedbackId: feedback.id,
      status: 'reviewed',
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });

  it('reviewed -> sent 缺省 sentAt 使用注入 TrustedClock 一次', async () => {
    const feedback = await createStatusFixture('reviewed');
    const token = new Date('2031-02-03T04:05:06.789Z');
    const clock = fixedClock(token);

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
    });

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ status: 'sent', sentAt: token }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).sentAtTs).toEqual(token);
  });

  it('sent -> sent 保留已有 sentAt 且不调用 clock；历史 null 才用 clock 补齐', async () => {
    const historical = new Date('2030-01-01T00:00:00.123Z');
    const alreadySent = await createStatusFixture('sent', historical);
    const nullSent = await createStatusFixture('sent', null);
    const clock = fixedClock();
    const service = createService(clock);

    const preserved = await service.updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: alreadySent.id, status: 'sent' });
    expect(preserved).toEqual({ ok: true, value: expect.objectContaining({ sentAt: historical }) });
    expect(clock.now).toHaveBeenCalledTimes(1);

    const filled = await service.updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: nullSent.id, status: 'sent' });
    expect(filled).toEqual({ ok: true, value: expect.objectContaining({ sentAt: new Date('2031-02-03T04:05:06.789Z') }) });
    expect(clock.now).toHaveBeenCalledTimes(2);
  });

  it('sent -> sent 显式相同 instant 幂等成功，首次 sentAt 保持不变', async () => {
    const historical = new Date('2030-01-01T00:00:00.123Z');
    const feedback = await createStatusFixture('sent', historical);
    const clock = fixedClock();

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
      sentAt: '2030-01-01T08:00:00.123+08:00',
    });

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ sentAt: historical }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).sentAtTs).toEqual(historical);
  });

  it('sent -> sent 显式不同 instant 返回 sentAt 冲突且零写', async () => {
    const historical = new Date('2030-01-01T00:00:00.123Z');
    const feedback = await createStatusFixture('sent', historical);
    const before = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    const clock = fixedClock();

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
      sentAt: '2040-12-31T23:59:59Z',
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'sentAt' }) });
    expect(clock.now).not.toHaveBeenCalled();
    expect(await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).toEqual(before);
  });

  it.each(['draft', 'reviewed', 'archived'] as const)('同状态 %s -> %s 保持允许且不调用 clock', async (status) => {
    const feedback = await createStatusFixture(status);
    const clock = fixedClock();

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status,
    });

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ status }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'clock错误',
      { now: vi.fn().mockResolvedValue(err(internalError('clock failed'))) },
      internalError('clock failed'),
    ],
    [
      'clock无效token',
      { now: vi.fn().mockResolvedValue(ok(new Date('invalid'))) },
      internalError('TrustedClock返回无效时间'),
    ],
  ])('%s 时返回精确错误且零写', async (_label, clock, expectedError) => {
    const feedback = await createStatusFixture('reviewed');
    const before = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
    });

    expect(result).toEqual({ ok: false, error: expectedError });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).toEqual(before);
  });

  it.each([
    ['Z', '2031-02-03T04:05:06.123456789Z', '2031-02-03T04:05:06.123Z'],
    ['offset', '2031-02-03T12:05:06.1234+08:00', '2031-02-03T04:05:06.123Z'],
    ['最大正 offset', '2031-02-03T23:59:59+23:59', '2031-02-03T00:00:59.000Z'],
    ['最大负 offset', '2031-02-03T00:00:00-23:59', '2031-02-03T23:59:00.000Z'],
  ])('显式 %s sentAt 写正确毫秒 instant 且不调用 clock', async (_label, sentAt, expected) => {
    const feedback = await createStatusFixture('reviewed');
    const clock = fixedClock();

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status: 'sent',
      sentAt,
    });

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ sentAt: new Date(expected) }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  it.each([
    '2031-02-03',
    '2031-02-03 04:05:06Z',
    '2031-02-03T04:05:06',
    '2031-02-03T24:00:00Z',
    '2031-02-29T04:05:06Z',
    '2031-02-03T04:60:00Z',
    '2031-02-03T04:05:60Z',
    '2031-02-03T04:05:06.1234567890Z',
    '2031-02-03T04:05:06+24:00',
    '2031-02-03T04:05:06+08:60',
    '',
    123,
  ])('拒绝非法显式 sentAt %#，且错误优先于 NOT_FOUND 响应并不调用 clock', async (sentAt) => {
    const clock = fixedClock();
    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: 'missing',
      status: 'sent',
      sentAt: sentAt as never,
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'sentAt' }) });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each(['draft', 'reviewed', 'archived'] as const)('非 sent 状态 %s 携带 sentAt 拒绝且零写', async (status) => {
    const feedback = await createStatusFixture(status);
    const clock = fixedClock();
    const before = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });

    const result = await createService(clock).updateFeedbackStatus({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      status,
      sentAt: '2031-02-03T04:05:06Z',
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'sentAt' }) });
    expect(clock.now).not.toHaveBeenCalled();
    expect(await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).toEqual(before);
  });

  it('not found、跨 teacher、draft 直接 sent 均不调用 clock；archived 保留 sentAt', async () => {
    const draft = await createStatusFixture('draft');
    const sentAt = new Date('2030-01-01T00:00:00.123Z');
    const sent = await createStatusFixture('sent', sentAt);
    const clock = fixedClock();
    const service = createService(clock);

    const missing = await service.updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: 'missing', status: 'sent' });
    const crossed = await service.updateFeedbackStatus({ teacherId: TEACHER_B, feedbackId: draft.id, status: 'sent' });
    const direct = await service.updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: draft.id, status: 'sent' });
    const archived = await service.updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: sent.id, status: 'archived' });

    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    expect(crossed).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    expect(direct).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'status' }) });
    expect(archived).toEqual({ ok: true, value: expect.objectContaining({ status: 'archived', sentAt }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  describe('reviewed -> sent 本地出站审核', () => {
    it('命中 review 仍发送，持久化标记且结构化日志不含明文', async () => {
      const feedback = await createStatusFixture('reviewed');
      const logger = loggerSpy();
      const adapter = moderationAdapter('local', vi.fn().mockResolvedValue({
        verdict: 'review',
        labels: ['violence'],
        flagged: true,
        reasons: ['violence（暴力/威胁言论）', '状态测试内容'],
      }));

      const result = await createService(fixedClock(), adapter, logger).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent',
      });

      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({
          status: 'sent', moderationFlagged: true, moderationReasons: ['violence（暴力/威胁言论）'],
        }),
      });
      expect(adapter.moderateText).toHaveBeenCalledWith({ text: 'reviewed反馈\n状态测试内容', scene: 'feedback' });
      const persisted = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
      expect(persisted).toMatchObject({ status: 'sent', moderationFlagged: true, moderationReasons: ['violence（暴力/威胁言论）'] });
      const logPayload = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);
      expect(logger.info).toHaveBeenCalledWith('feedback moderation flag', {
        teacherId: TEACHER_A, feedbackId: feedback.id, reasons: ['violence（暴力/威胁言论）'],
      });
      expect(logPayload).not.toContain('reviewed反馈');
      expect(logPayload).not.toContain('状态测试内容');
    });

    it('本地检查通过写 false/[]，且数据库继续保存 title/content 密文', async () => {
      const student = await createStudentFixture(TEACHER_A, '密文审核学生');
      const created = await createFeedbackService({ prisma, cipher }).createFeedback({
        teacherId: TEACHER_A, studentId: student.id, title: '敏感审核标题', content: '敏感审核正文',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await createFeedbackService({ prisma, cipher }).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: created.value.id, status: 'reviewed',
      });
      const adapter = moderationAdapter('local', vi.fn().mockResolvedValue({
        verdict: 'pass', labels: [], flagged: false, reasons: [],
      }));

      const result = await createFeedbackService({ prisma, cipher, moderation: adapter }).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: created.value.id, status: 'sent',
      });

      expect(result).toEqual({ ok: true, value: expect.objectContaining({ moderationFlagged: false, moderationReasons: [] }) });
      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
      expect(db.moderationFlagged).toBe(false);
      expect(db.moderationReasons).toEqual([]);
      expect(db.title).not.toContain('敏感审核标题');
      expect(db.content).not.toContain('敏感审核正文');
    });

    it('未配置审核保持 null，非 reviewed -> sent 不调用 adapter', async () => {
      const unconfigured = await createStatusFixture('reviewed');
      const noCheck = await createService().updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: unconfigured.id, status: 'sent',
      });
      expect(noCheck).toEqual({ ok: true, value: expect.objectContaining({ moderationFlagged: null, moderationReasons: null }) });

      const reviewed = await createStatusFixture('reviewed');
      const adapter = moderationAdapter('local', vi.fn());
      const archived = await createService(undefined, adapter).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: reviewed.id, status: 'archived',
      });
      expect(archived.ok).toBe(true);
      expect(adapter.moderateText).not.toHaveBeenCalled();
    });

    it('local adapter 未实际审核时保持 null，而不误记为 pass', async () => {
      const feedback = await createStatusFixture('reviewed');
      const adapter = moderationAdapter('local', vi.fn().mockResolvedValue({
        verdict: 'review', labels: ['local-moderation-disabled'], flagged: false, reasons: [],
      }));
      const result = await createService(undefined, adapter).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent',
      });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ moderationFlagged: null, moderationReasons: null }) });
    });

    it('adapter 异常 fail-open + warn，审核列保持 null 且日志无明文', async () => {
      const feedback = await createStatusFixture('reviewed');
      const logger = loggerSpy();
      const adapter = moderationAdapter('local', vi.fn().mockRejectedValue(new Error('状态测试内容')));

      const result = await createService(fixedClock(), adapter, logger).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent',
      });

      expect(result).toEqual({ ok: true, value: expect.objectContaining({ status: 'sent', moderationFlagged: null, moderationReasons: null }) });
      expect(logger.warn).toHaveBeenCalledWith('feedback moderation check failed', {
        teacherId: TEACHER_A,
        feedbackId: feedback.id,
        errorCode: 'LOCAL_MODERATION_FAILED',
        errorType: 'Error',
      });
      const warnPayload = JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls);
      expect(warnPayload).not.toContain('状态测试内容');
      expect(warnPayload).not.toContain('message');
      expect(warnPayload).not.toContain('stack');
    });

    it.each(['external', 'unknown'])('provider=%s 绝不接收 S1 明文', async (provider) => {
      const feedback = await createStatusFixture('reviewed');
      const adapter = moderationAdapter(provider, vi.fn());
      const result = await createService(undefined, adapter).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent',
      });
      expect(result.ok).toBe(true);
      expect(adapter.moderateText).not.toHaveBeenCalled();
      expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).moderationFlagged).toBeNull();
    });

    it('审核后并发编辑令 updatedAt/status/owner CAS 冲突，拒绝陈旧投影发送', async () => {
      const feedback = await createStatusFixture('reviewed');
      const adapter = moderationAdapter('local', vi.fn(async () => {
        await prisma.parentFeedback.update({
          where: { id: feedback.id },
          data: { title: encryptFieldValue(cipher, '审核后的并发标题') },
        });
        return { verdict: 'pass' as const, labels: [], flagged: false, reasons: [] };
      }));

      const result = await createFeedbackService({ prisma, cipher, moderation: adapter }).updateFeedbackStatus({
        teacherId: TEACHER_A, feedbackId: feedback.id, status: 'sent',
      });

      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) });
      expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    });
  });

  describe('I4b 审计时间治理', () => {
    it('createFeedback 时 createdAt/updatedAt 由 TrustedClock 写入且同源', async () => {
      const token = new Date('2031-05-06T07:08:09.123Z');
      const clock = fixedClock(token);
      const student = await createStudentFixture(TEACHER_A, '同源-学生');

      const result = await createService(clock).createFeedback({
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '同源测试',
        content: '同源内容',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.createdAt).toEqual(token);
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: result.value.id } });
      expect(db.createdAtTs).toEqual(token);
      expect(db.updatedAtTs).toEqual(token);
    });

    it('updateFeedbackContent 时 updatedAt 由 TrustedClock 写入', async () => {
      const student = await createStudentFixture(TEACHER_A, '更新-学生');
      const createResult = await createService().createFeedback({
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '原标题',
        content: '原内容',
      });
      if (!createResult.ok) return;

      const token = new Date('2031-06-07T08:09:10.456Z');
      const clock = fixedClock(token);
      const result = await createService(clock).updateFeedbackContent({
        teacherId: TEACHER_A,
        feedbackId: createResult.value.id,
        title: '新标题',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toBe('新标题');
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: result.value.id } });
      expect(db.updatedAtTs).toEqual(token);
    });

    it('updateFeedbackStatus 时 sentAt 与 updatedAt 同源（同一 clock 调用）', async () => {
      const feedback = await createStatusFixture('reviewed');
      const token = new Date('2031-07-08T09:10:11.789Z');
      const clock = fixedClock(token);

      const result = await createService(clock).updateFeedbackStatus({
        teacherId: TEACHER_A,
        feedbackId: feedback.id,
        status: 'sent',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sentAt).toEqual(token);
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
      expect(db.sentAtTs).toEqual(token);
      expect(db.updatedAtTs).toEqual(token);
    });
  });
});

// ===== D40 Phase 5: 依据快照落库 =====

describe('feedbackService.createFeedback with evidence snapshot', () => {
  it('带 evidence 时，反馈 + 快照 + evidence 明细同事务原子落库，字段 roundtrip 正确', async () => {
    const student = await createStudentFixture(TEACHER_A, '快照学生');
    const token = new Date('2031-03-04T05:06:07.123Z');
    const clock = fixedClock(token);

    const evidence = [
      {
        id: 'rec-1',
        type: 'assessment' as const,
        occurredAt: '2026-01-15T10:00:00Z',
        category: '月考',
        summary: '数学月考成绩优秀',
        examName: '高一上学期第一次月考',
        subject: '数学',
        score: 92,
        fullScore: 100,
        previousScore: 85,
        parentConcerns: ['解题步骤不规范', '粗心失分'],
        followUps: ['加强错题本练习'],
      },
      {
        id: 'lesson-1',
        type: 'lesson' as const,
        occurredAt: '2026-01-20T14:00:00+08:00',
        category: null,
        summary: null,
        examName: null,
        subject: null,
        score: null,
        fullScore: null,
        previousScore: null,
        parentConcerns: null,
        followUps: null,
      },
      {
        type: 'record' as const,
        occurredAt: '2026-02-01T00:00:00Z',
        summary: '家长主动沟通',
      },
    ];

    const result = await createService(clock).createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '带快照反馈',
      content: '内容',
      evidence,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-02-01T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ParentFeedback 已建
    const fbCount = await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } });
    expect(fbCount).toBe(1);

    // FeedbackContextSnapshot 已建，字段正确
    const snapshot = await prisma.feedbackContextSnapshot.findFirstOrThrow({
      where: { feedbackId: result.value.id, teacherId: TEACHER_A },
    });
    expect(snapshot.teacherId).toBe(TEACHER_A);
    expect(snapshot.windowStartTs).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(snapshot.windowEndTs).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(snapshot.assembledAtTs).toEqual(token);

    // FeedbackEvidence 已建 3 条，sortOrder 正确
    const records = await prisma.feedbackEvidence.findMany({
      where: { snapshotId: snapshot.id, teacherId: TEACHER_A },
      orderBy: { sortOrder: 'asc' },
    });
    expect(records).toHaveLength(3);
    expect(records[0].sortOrder).toBe(0);
    expect(records[0].type).toBe('assessment');
    expect(records[0].recordId).toBe('rec-1');
    expect(records[0].occurredAtTs).toEqual(new Date('2026-01-15T10:00:00Z'));
    expect(records[0].category).toBe('月考');
    // P8 phase-3 批5：summary/parentConcerns/followUps 落库为密文，解密后断言
    expect(records[0].summary).not.toBe('数学月考成绩优秀');
    expect(cipher.decrypt(records[0].summary!)).toBe('数学月考成绩优秀');
    expect(records[0].examName).toBe('高一上学期第一次月考');
    expect(records[0].subject).toBe('数学');
    expect(records[0].score).toBe(92);
    expect(records[0].fullScore).toBe(100);
    expect(records[0].previousScore).toBe(85);
    expect(cipher.decryptJson<unknown>(records[0].parentConcerns as unknown as string)).toEqual(['解题步骤不规范', '粗心失分']);
    expect(cipher.decryptJson<unknown>(records[0].followUps as unknown as string)).toEqual(['加强错题本练习']);

    expect(records[1].sortOrder).toBe(1);
    expect(records[1].type).toBe('lesson');
    expect(records[1].recordId).toBe('lesson-1');
    expect(records[1].occurredAtTs).toEqual(new Date('2026-01-20T06:00:00.000Z'));
    expect(records[1].parentConcerns).toEqual([]);
    expect(records[1].followUps).toEqual([]);

    expect(records[2].sortOrder).toBe(2);
    expect(records[2].type).toBe('record');
    expect(records[2].recordId).toBeNull();
    expect(records[2].occurredAtTs).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(cipher.decrypt(records[2].summary!)).toBe('家长主动沟通');
  });

  it('无 evidence 时不建快照，行为与现状一致', async () => {
    const student = await createStudentFixture(TEACHER_A, '无快照学生');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '普通反馈',
      content: '内容',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshotCount = await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_A } });
    expect(snapshotCount).toBe(0);

    const evidenceCount = await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_A } });
    expect(evidenceCount).toBe(0);
  });

  it('非法 type 返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '非法type');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [{ type: 'invalid' as never, occurredAt: '2026-01-01T00:00:00Z' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('evidence[0].type');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('非法 occurredAt 返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '坏日期');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [{ type: 'record', occurredAt: '2026-01-01' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('evidence[0].occurredAt');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('score 非数字返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '坏分数');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [{ type: 'assessment', occurredAt: '2026-01-01T00:00:00Z', score: 'abc' as never }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('evidence[0].score');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('parentConcerns 非数组返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '坏数组');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [{ type: 'record', occurredAt: '2026-01-01T00:00:00Z', parentConcerns: 'not-array' as never }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('evidence[0].parentConcerns');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('evidence 超过 100 条返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '超量');
    const evidence = Array.from({ length: 101 }, (_, i) => ({
      type: 'record' as const,
      occurredAt: '2026-01-01T00:00:00Z',
      summary: `item-${i}`,
    }));

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('evidence');
    expect(result.error.message).toContain('evidence 条目过多');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('windowStart 坏日期返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '坏windowStart');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [],
      windowStart: 'not-a-date',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('windowStart');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('windowEnd 坏日期返回 VALIDATION_ERROR 且零写入', async () => {
    const student = await createStudentFixture(TEACHER_A, '坏windowEnd');

    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [],
      windowEnd: 'not-a-date',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('windowEnd');
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('事务原子性：snapshot 数据库写入失败时反馈、快照和证据全部回滚', async () => {
    const student = await createStudentFixture(TEACHER_A, '原子性学生');
    const failingPrisma = prisma.$extends({
      query: {
        feedbackContextSnapshot: {
          async create() {
            throw new Error('forced snapshot database failure');
          },
        },
      },
    });
    const service = createFeedbackService({
      prisma: failingPrisma as unknown as PrismaClient,
      trustedClock: fixedClock(),
    });

    const result = await service.createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '标题',
      content: '内容',
      evidence: [
        { type: 'assessment', occurredAt: '2026-01-01T00:00:00Z', score: 95 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_A } })).toBe(0);
    expect(await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  });

  it('空 evidence 数组仍然建快照（0 条明细）', async () => {
    const student = await createStudentFixture(TEACHER_A, '空evidence');
    const token = new Date('2031-04-05T06:07:08.456Z');
    const clock = fixedClock(token);

    const result = await createService(clock).createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '空 evidence 反馈',
      content: '内容',
      evidence: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshot = await prisma.feedbackContextSnapshot.findFirst({
      where: { feedbackId: result.value.id, teacherId: TEACHER_A },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.assembledAtTs).toEqual(token);

    const evidenceCount = await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_A } });
    expect(evidenceCount).toBe(0);
  });
});

describe('feedbackService.getFeedbackSnapshot', () => {
  async function createSnapshotFeedback(teacherId = TEACHER_A) {
    const student = await createStudentFixture(teacherId, '快照查询学生');
    const clock = fixedClock(new Date('2031-05-06T07:08:09.123Z'));
    const evidence = [
      {
        id: 'rec-1',
        type: 'assessment' as const,
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
    const result = await createService(clock).createFeedback({
      teacherId,
      studentId: student.id,
      title: '快照反馈',
      content: '内容',
      evidence,
      windowStart: '2026-01-01T00:00:00Z',
      windowEnd: '2026-02-01T00:00:00Z',
    });
    if (!result.ok) throw new Error('fixture create failed');
    return result.value;
  }

  it('按 teacherId + feedbackId 查询快照，evidence 按 sortOrder', async () => {
    const feedback = await createSnapshotFeedback();

    const result = await createService().getFeedbackSnapshot({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.feedbackId).toBe(feedback.id);
    expect(result.value.windowStart).toBe('2026-01-01T00:00:00.000Z');
    expect(result.value.windowEnd).toBe('2026-02-01T00:00:00.000Z');
    expect(result.value.assembledAt).toBe('2031-05-06T07:08:09.123Z');
    expect(result.value.evidence).toHaveLength(1);
    expect(result.value.evidence[0].id).toBe('rec-1');
    expect(result.value.evidence[0].type).toBe('assessment');
    expect(result.value.evidence[0].occurredAt).toBe('2026-01-15T10:00:00.000Z');
    expect(result.value.evidence[0].category).toBe('月考');
    expect(result.value.evidence[0].score).toBe(92);
    expect(result.value.evidence[0].parentConcerns).toEqual(['解题步骤不规范']);
    expect(result.value.evidence[0].followUps).toEqual(['加强错题本练习']);
  });

  it('跨 teacher 查询返回 NOT_FOUND', async () => {
    const feedback = await createSnapshotFeedback(TEACHER_A);

    const result = await createService().getFeedbackSnapshot({
      teacherId: TEACHER_B,
      feedbackId: feedback.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('无快照的反馈返回 NOT_FOUND', async () => {
    const student = await createStudentFixture(TEACHER_A, '无快照学生');
    const result = await createService().createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '普通反馈',
      content: '内容',
    });
    if (!result.ok) return;

    const snapshot = await createService().getFeedbackSnapshot({
      teacherId: TEACHER_A,
      feedbackId: result.value.id,
    });

    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) return;
    expect(snapshot.error.code).toBe('NOT_FOUND');
    expect(snapshot.error.message).toContain('该反馈没有依据快照');
  });

  it('feedbackId 不存在返回 NOT_FOUND', async () => {
    const result = await createService().getFeedbackSnapshot({
      teacherId: TEACHER_A,
      feedbackId: 'nonexistent-id',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toContain('家长反馈不存在');
  });
});
