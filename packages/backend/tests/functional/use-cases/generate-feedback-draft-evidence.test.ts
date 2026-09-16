import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createGenerateFeedbackDraftUseCase } from '../../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
import { createFieldCipherFromEnv, encryptFieldValue, encryptJsonFieldValue } from '../../../src/shared/field-encryption/index.js';
import { prisma, TEACHER_A, createStudentFixture, createLessonFixture, createMockAiClient } from './generate-feedback-draft-use-case.fixtures.js';
const cipher = createFieldCipherFromEnv();
const response = { ok: true as const, value: { content: '标题：学习进展\n内容：今天能独立完成三道计算题，下次继续练习验算。\n所以这样写：根据已确认事实说明下一步。' } };
function setup(chat = createMockAiClient(response)) {
  const context = createAssembleParentFeedbackContextUseCase({ prisma, cipher });
  return { chat, useCase: createGenerateFeedbackDraftUseCase({ prisma, cipher, aiClient: chat, context }) };
}
async function fixture() {
  const student = await createStudentFixture(TEACHER_A, '合成学生');
  const lesson = await createLessonFixture({ teacherId: TEACHER_A, studentId: student.id, progress: '已确认三道计算题', dateTs: new Date() });
  const record = await prisma.studentRecord.findFirstOrThrow({ where: { studentId: student.id } });
  return { student, lesson, record };
}
async function makeRecord(studentId: string, summary: string, visibility = 'parent_shareable') {
  return prisma.studentRecord.create({ data: { teacherId: TEACHER_A, studentId, category: 'general_note',
    summary, occurredAtTs: new Date(), reviewStatus: 'confirmed', visibility } });
}

describe('A05 generation uses only current server evidence', () => {
  it('explicit lesson excludes raw lesson fields and unrelated window facts', async () => {
    const { student, lesson, record } = await fixture();
    await prisma.lesson.update({ where: { id: lesson.id }, data: { progress: '内部课堂评语', teacherNote: '绝不外发备注' } });
    await makeRecord(student.id, '无关时间窗记录');
    const { chat, useCase } = setup();
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.evidence.map(item => item.id)).toEqual([record.id]);
    const prompt = JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0]);
    expect(prompt).toContain('已确认三道计算题');
    for (const text of ['内部课堂评语', '绝不外发备注', '无关时间窗记录']) expect(prompt).not.toContain(text);
  });

  it.each(['internal_only', 'needs_review', 'missing'])('raw lesson does not bypass %s formal source', async visibility => {
    const { student, lesson, record } = await fixture();
    if (visibility === 'missing') await prisma.studentRecord.delete({ where: { id: record.id } });
    else await prisma.studentRecord.update({ where: { id: record.id }, data: { visibility } });
    await makeRecord(student.id, '不可替代所选课次的其他记录');
    const { chat, useCase } = setup();
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });
    expect(result.ok).toBe(false);
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('explicit old lesson includes its confirmed facts beyond default window with encrypted association', async () => {
    const { student, lesson, record } = await fixture();
    await prisma.studentRecord.update({ where: { id: record.id }, data: { occurredAtTs: new Date('2020-01-01T00:00:00Z'),
      summary: encryptFieldValue(cipher, '可分享的历史课次事实'),
      structuredData: encryptJsonFieldValue(cipher, { lessonId: lesson.id }) } });
    const { useCase, chat } = setup();
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0])).toContain('可分享的历史课次事实');
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0])).not.toContain('enc:v1');
  });

  it.each(['summary', 'visibility', 'reviewStatus', 'delete', 'association', 'child'] as const)('rejects %s change during model generation', async change => {
    const { student, lesson, record } = await fixture();
    const chat = createMockAiClient(response);
    vi.mocked(chat.chat).mockImplementation(async () => {
      if (change === 'delete') await prisma.studentRecord.delete({ where: { id: record.id } });
      else if (change === 'child') await prisma.communicationDetail.create({ data: { teacherId: TEACHER_A, studentRecordId: record.id,
        direction: 'two_way', parentConcerns: ['新增关注'] } });
      else await prisma.studentRecord.update({ where: { id: record.id }, data: change === 'summary' ? { summary: '事实已更正' }
        : change === 'visibility' ? { visibility: 'internal_only' }
          : change === 'reviewStatus' ? { reviewStatus: 'superseded' } : { structuredData: { lessonId: 'another-lesson' } } });
      return response;
    });
    try {
      const { useCase } = setup(chat);
      const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VERSION_CONFLICT');
      expect(JSON.stringify(result)).not.toContain('今天能独立');
      expect(await prisma.parentFeedback.count({ where: { studentId: student.id } })).toBe(0);
    } finally {
      await prisma.communicationDetail.deleteMany({ where: { studentRecordId: record.id } });
    }
  });

  it('pre-model revalidation rejects modified context before any model attempt', async () => {
    const { student, lesson, record } = await fixture();
    const context = createAssembleParentFeedbackContextUseCase({ prisma, cipher });
    const chat = createMockAiClient(response);
    const execute = context.execute.bind(context);
    context.execute = async input => {
      const assembled = await execute(input);
      await prisma.studentRecord.update({ where: { id: record.id }, data: { summary: '组装后更正' } });
      return assembled;
    };
    const useCase = createGenerateFeedbackDraftUseCase({ prisma, cipher, aiClient: chat, context });
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] });
    expect(result.ok).toBe(false);
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('decrypts student identity but excludes historic feedback and unconfirmed profile facts', async () => {
    const { student } = await fixture();
    await prisma.student.update({ where: { id: student.id }, data: { name: encryptFieldValue(cipher, '加密姓名'),
      grade: encryptFieldValue(cipher, '五年级'), stageGoal: encryptFieldValue(cipher, '未确认画像目标') } });
    await prisma.parentFeedback.create({ data: { teacherId: TEACHER_A, studentId: student.id, title: '旧反馈生成事实',
      content: '历史生成内容不能成为事实', status: 'sent', sentAtTs: new Date('2020-01-01T00:00:00Z') } });
    const { chat, useCase } = setup();
    expect((await useCase.execute({ teacherId: TEACHER_A, studentId: student.id })).ok).toBe(true);
    const prompt = JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0]);
    expect(prompt).toContain('加密姓名'); expect(prompt).toContain('五年级');
    for (const text of ['未确认画像目标', '历史生成内容不能成为事实', '旧反馈生成事实', 'enc:v1']) expect(prompt).not.toContain(text);
  });

  it.each(['', '标题：空内容\n内容：\n所以这样写：无正文', '标题：只有标题'])('rejects incomplete model content %j', async content => {
    const { student } = await fixture();
    const { useCase } = setup(createMockAiClient({ ok: true, value: { content } }));
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(false);
    expect(await prisma.parentFeedback.count({ where: { studentId: student.id } })).toBe(0);
  });
  it.each(['association', 'future', 'old'] as const)('rejects %s mutation between selection and authority resolution', async change => {
    const { student, lesson, record } = await fixture();
    let selected = false;
    const hooked = prisma.$extends({ query: { studentRecord: { async findMany({ args, query }) {
      const result = await query(args);
      if (!selected) {
        selected = true;
        await prisma.studentRecord.update({ where: { id: record.id }, data: change === 'association'
          ? { structuredData: { lessonId: 'different-lesson' } }
          : { occurredAtTs: new Date(change === 'future' ? '2099-01-01T00:00:00Z' : '2000-01-01T00:00:00Z') } });
      }
      return result;
    } } } }) as unknown as PrismaClient;
    const context = createAssembleParentFeedbackContextUseCase({ prisma: hooked, cipher });
    const result = await context.execute({ teacherId: TEACHER_A, studentId: student.id,
      ...(change === 'association' ? { lessonIds: [lesson.id] } : {}) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VERSION_CONFLICT');
  });

  it('does not admit contradictory lesson and schedule links', async () => {
    const { student, lesson, record } = await fixture();
    await prisma.studentRecord.update({ where: { id: record.id }, data: {
      structuredData: { lessonId: 'different-lesson', scheduleId: lesson.scheduleId } } });
    const { chat, useCase } = setup();
    expect((await useCase.execute({ teacherId: TEACHER_A, studentId: student.id, lessonIds: [lesson.id] })).ok).toBe(false);
    expect(chat.chat).not.toHaveBeenCalled();
  });

});
