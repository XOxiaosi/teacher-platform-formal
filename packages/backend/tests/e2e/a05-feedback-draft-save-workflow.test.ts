import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createAssembleParentFeedbackContextUseCase } from '../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
import { createGenerateFeedbackDraftUseCase } from '../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js';
import { createFeedbackService } from '../../src/features/feedback/index.js';
import { createFieldCipherFromEnv, encryptFieldValue } from '../../src/shared/field-encryption/index.js';
import type { AiClient, ChatMessage, ChatToolDefinition } from '../../src/shared/ai-client/types.js';

const prisma = new PrismaClient();
const cipher = createFieldCipherFromEnv();
const TEACHER = 'a05-e2e-draft-save-teacher';

async function cleanup() {
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER } });
}

async function fixture() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER, name: '端到端合成学生', grade: '高一', source: 'test' },
  });
  const scheduledStartTs = new Date();
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      type: 'lesson',
      title: '端到端反馈课次',
      scheduledStartTs,
      scheduledEndTs: new Date(scheduledStartTs.getTime() + 90 * 60 * 1000),
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: scheduledStartTs,
      status: 'attended',
      progress: '独立完成三道计算题并主动验算',
    },
  });
  const record = await prisma.studentRecord.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      category: 'lesson_observation',
      summary: encryptFieldValue(cipher, '独立完成三道计算题并主动验算'),
      structuredData: { lessonId: lesson.id, scheduleId: schedule.id },
      occurredAtTs: scheduledStartTs,
      reviewStatus: 'confirmed',
      visibility: 'parent_shareable',
    },
  });
  return { student, lesson, record };
}

function fakeAiClient() {
  return {
    run: vi.fn(async () => ok({})),
    chat: vi.fn(async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => ok({
      content: '标题：本次课堂的主动验算\n内容：本次课小明独立完成三道计算题，并主动检查了每一步。接下来继续练习验算。\n所以这样写：用具体课堂行为让家长看见可延续的进展。',
    })),
  } as unknown as AiClient;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('A05 反馈草稿端到端保存闭环', () => {
  it('查询当前课次依据 → 生成待核对草稿 → 显式保存 → 编辑并确认 → 可读回依据快照', async () => {
    const { student, lesson, record } = await fixture();
    const aiClient = fakeAiClient();
    const context = createAssembleParentFeedbackContextUseCase({ prisma, cipher });
    const generator = createGenerateFeedbackDraftUseCase({ prisma, cipher, aiClient, context });

    const draft = await generator.execute({ teacherId: TEACHER, studentId: student.id, lessonIds: [lesson.id], focus: 'highlight' });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.value.source).toBe('ai');
    expect(draft.value.evidence.map((item) => item.id)).toEqual([record.id]);
    expect(draft.value.content).toContain('独立完成三道计算题');
    // 生成只返回待核对结果，不应在教师明确保存前创建正式反馈。
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER, studentId: student.id } })).toBe(0);

    const service = createFeedbackService({ prisma, cipher });
    const saveInput = {
      teacherId: TEACHER,
      studentId: student.id,
      lessonId: lesson.id,
      title: draft.value.title,
      content: draft.value.content,
      evidence: draft.value.evidence,
      windowStart: draft.value.windowStart,
      windowEnd: draft.value.windowEnd,
      clientRequestId: 'a05-e2e-save-0001',
    };
    const saved = await service.createFeedback(saveInput);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.status).toBe('draft');
    expect(saved.value.replayed).toBe(false);
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER, studentId: student.id } })).toBe(1);

    const edited = await service.updateFeedbackContent({
      teacherId: TEACHER,
      feedbackId: saved.value.id,
      content: '老师核对后补充：小明还主动检查了单位，下一次继续保持这个习惯。',
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.status).toBe('draft');

    const reviewed = await service.updateFeedbackStatus({ teacherId: TEACHER, feedbackId: saved.value.id, status: 'reviewed' });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.status).toBe('reviewed');
    expect(reviewed.value.sentAt).toBeNull();

    const snapshot = await service.getFeedbackSnapshot({ teacherId: TEACHER, feedbackId: saved.value.id });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.evidence).toHaveLength(1);
    expect(snapshot.value.evidence[0]?.id).toBe(record.id);
    expect(snapshot.value.evidence[0]?.summary).toContain('独立完成三道计算题');

    const replay = await service.createFeedback(saveInput);
    expect(replay).toEqual({ ok: true, value: expect.objectContaining({ id: saved.value.id, replayed: true }) });
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER, studentId: student.id } })).toBe(1);
  });

  it('生成后依据版本变化会阻止保存，且不写入反馈', async () => {
    const { student, lesson, record } = await fixture();
    const context = createAssembleParentFeedbackContextUseCase({ prisma, cipher });
    const generator = createGenerateFeedbackDraftUseCase({ prisma, cipher, aiClient: fakeAiClient(), context });
    const draft = await generator.execute({ teacherId: TEACHER, studentId: student.id, lessonIds: [lesson.id] });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    await prisma.studentRecord.update({ where: { id: record.id }, data: { summary: encryptFieldValue(cipher, '依据已经发生变化') } });
    const service = createFeedbackService({ prisma, cipher });
    const rejected = await service.createFeedback({
      teacherId: TEACHER, studentId: student.id, lessonId: lesson.id,
      title: draft.value.title, content: draft.value.content, evidence: draft.value.evidence,
      windowStart: draft.value.windowStart, windowEnd: draft.value.windowEnd, clientRequestId: 'a05-e2e-stale-0001',
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER, studentId: student.id } })).toBe(0);
  });
});
