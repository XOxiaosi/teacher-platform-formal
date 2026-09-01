import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { internalError, ok } from '@teacher-platform/contracts';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';

let createEditor: unknown;
let importError: unknown;
try {
  const module = await import('../../../src/features/feedback/parent-feedback-content-editor.js');
  createEditor = module.createParentFeedbackContentEditor;
} catch (caught) {
  importError = caught;
}

const prisma = new PrismaClient();
const TEACHER_A = 'feedback-editor-a';
const TEACHER_B = 'feedback-editor-b';
const BASE_TOKEN = new Date('2030-01-01T00:00:00.000Z');
const NEXT_TOKEN = new Date('2030-01-02T00:00:00.000Z');

function requireFactory() {
  if (importError) throw new Error(`feedback editor import failed: ${importError instanceof Error ? importError.message : String(importError)}`);
  if (typeof createEditor !== 'function') throw new Error('createParentFeedbackContentEditor export is missing');
  return createEditor as (options: { prisma: PrismaClient; trustedClock: any }) => {
    updateParentFeedbackContent(input: any): Promise<any>;
  };
}

function trustedClock(result: any = ok(NEXT_TOKEN)) {
  return { now: vi.fn().mockResolvedValue(result) };
}

async function createFixture(teacherId = TEACHER_A) {
  const student = await prisma.student.create({
    data: { teacherId, name: `学生-${teacherId}`, grade: '高一', source: 'test' },
  });
  return prisma.parentFeedback.create({
    data: {
      teacherId, studentId: student.id, title: '原反馈', content: '原内容',
      status: 'reviewed', channel: 'wechat', parentName: '学生家长',
      sentAtTs: new Date('2029-12-01T00:00:00.000Z'), updatedAtTs: BASE_TOKEN,
    },
  });
}

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('ParentFeedbackContentEditor owner CAS', () => {
  it('导出独立窄owner且保留旧内容与状态方法', () => {
    expect(requireFactory()).toBeTypeOf('function');
    const legacy = createFeedbackService({ prisma });
    expect(legacy.updateFeedbackContent).toBeTypeOf('function');
    expect(legacy.updateFeedbackStatus).toBeTypeOf('function');
  });

  it('owned对象更新title/content并保持状态、关系和渠道字段', async () => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '新反馈', content: '新内容' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.before).toMatchObject({ title: '原反馈', content: '原内容' });
    expect(result.value.after).toMatchObject({
      title: '新反馈', content: '新内容', status: 'reviewed', studentId: feedback.studentId,
      lessonId: null, channel: 'wechat', parentName: '学生家长', sentAt: feedback.sentAtTs,
      updatedAt: NEXT_TOKEN,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(await prisma.changeLog.count({ where: { targetId: feedback.id } })).toBe(0);
  });

  it.each(['sent', 'archived'])('%s 后拒绝 content editor 修改，避免出站审核投影过期', async (status) => {
    const feedback = await createFixture();
    await prisma.parentFeedback.update({ where: { id: feedback.id }, data: { status } });
    const current = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: current.updatedAtTs,
      changes: { title: '终态后修改' },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'status' }) });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('更新写入 updatedAtTs 值', async () => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '双写标题' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    expect(record.updatedAtTs).toBeInstanceOf(Date);
    expect(record.updatedAtTs!.getTime()).toBe(NEXT_TOKEN.getTime());
  });

  it('省略字段保持原值', async () => {
    const feedback = await createFixture();
    const result = await requireFactory()({ prisma, trustedClock: trustedClock() }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '只改标题' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({ title: '只改标题', content: '原内容' });
  });

  it.each([
    { teacherId: TEACHER_B, feedbackId: 'owned' },
    { teacherId: TEACHER_A, feedbackId: 'missing' },
  ])('跨teacher或不存在统一NOT_FOUND且不调用clock', async ({ teacherId, feedbackId }) => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId, feedbackId: feedbackId === 'owned' ? feedback.id : feedbackId,
      expectedUpdatedAt: new Date('1999-01-01T00:00:00.000Z'), changes: { title: ' ' },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).title).toBe('原反馈');
  });

  it('owned stale优先于空白文本和no-op', async () => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id,
      expectedUpdatedAt: new Date('2029-12-31T00:00:00.000Z'),
      changes: { title: ' ', content: '原内容' },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT', field: 'expectedUpdatedAt' }) });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    { changes: {}, field: 'changes' },
    { changes: { status: 'sent' }, field: 'changes' },
    { changes: { sentAt: null }, field: 'changes' },
    { changes: { studentId: 'other' }, field: 'changes' },
    { changes: { lessonId: null }, field: 'changes' },
    { changes: { channel: null }, field: 'changes' },
    { changes: { parentName: null }, field: 'changes' },
    { changes: { title: '' }, field: 'title' },
    { changes: { title: '   ' }, field: 'title' },
    { changes: { content: '' }, field: 'content' },
    { changes: { title: 1 }, field: 'title' },
    { changes: { content: null }, field: 'content' },
  ])('拒绝非法owner输入：$field', async ({ changes, field }) => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs, changes,
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }) });
    expect(clock.now).not.toHaveBeenCalled();
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).updatedAtTs).toEqual(BASE_TOKEN);
  });

  it('事实no-op不推进token', async () => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: feedback.title, content: feedback.content },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'changes' }) });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('拒绝非法expected Date且不读取对象或调用clock', async () => {
    const feedback = await createFixture();
    const clock = trustedClock();
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: new Date(Number.NaN),
      changes: { title: '新标题' },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'expectedUpdatedAt' }) });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('clock阶段对象消失时CAS失败重读分类NOT_FOUND', async () => {
    const feedback = await createFixture();
    const clock = {
      now: vi.fn(async () => {
        await prisma.parentFeedback.delete({ where: { id: feedback.id } });
        return ok(NEXT_TOKEN);
      }),
    };
    const result = await requireFactory()({ prisma, trustedClock: clock }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '新标题' },
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'NOT_FOUND' }) });
  });

  it('TrustedClock失败或返回before同token时零写', async () => {
    const feedback = await createFixture();
    const failed = await requireFactory()({
      prisma, trustedClock: trustedClock({ ok: false, error: internalError('clock失败') }),
    }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '第一次修改' },
    });
    const sameToken = await requireFactory()({ prisma, trustedClock: trustedClock(ok(BASE_TOKEN)) }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { title: '第二次修改' },
    });
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect(sameToken).toEqual({ ok: false, error: expect.objectContaining({ code: 'INTERNAL_ERROR' }) });
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).title).toBe('原反馈');
  });

  it('system省略expected仍以before token执行CAS', async () => {
    const feedback = await createFixture();
    const result = await requireFactory()({ prisma, trustedClock: trustedClock() }).updateParentFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: undefined,
      changes: { content: '系统内容' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after).toMatchObject({ content: '系统内容', updatedAt: NEXT_TOKEN });
  });

  it('同expected并发恰好一胜一VERSION_CONFLICT', async () => {
    const feedback = await createFixture();
    const editor = requireFactory()({ prisma, trustedClock: trustedClock() });
    const input = {
      teacherId: TEACHER_A, feedbackId: feedback.id, expectedUpdatedAt: feedback.updatedAtTs,
      changes: { content: '并发内容' },
    };
    const results = await Promise.all([editor.updateParentFeedbackContent(input), editor.updateParentFeedbackContent(input)]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok && item.error.code === 'VERSION_CONFLICT')).toHaveLength(1);
  });
});
