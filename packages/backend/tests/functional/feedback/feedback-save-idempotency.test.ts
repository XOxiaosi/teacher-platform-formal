import { describe, expect, it } from 'vitest';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import { cipher, createService, createStudentFixture, fixedClock, prisma, TEACHER_A } from './feedback-service.fixtures.js';

describe('A05-SAVE 家长反馈保存回执', () => {
  it('同一租户请求编号重放不可重复写入，并返回加密的不可变回执', async () => {
    const student = await createStudentFixture(TEACHER_A, 'A05 幂等学生');
    const clock = fixedClock();
    const service = createService(clock);
    const input = {
      teacherId: TEACHER_A,
      studentId: student.id,
      clientRequestId: 'a05-save-0001',
      title: '阶段反馈标题',
      content: '阶段反馈正文',
      channel: 'wechat',
      parentName: '家长',
    };

    const first = await service.createFeedback(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const row = await prisma.parentFeedback.findUniqueOrThrow({
      where: { teacherId_clientRequestId: { teacherId: TEACHER_A, clientRequestId: input.clientRequestId } },
    });
    expect(row.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row.creationReceiptCiphertext).toMatch(/^enc:v1:/);
    expect(row.creationReceiptCiphertext).not.toContain(input.title);
    expect(row.creationReceiptCiphertext).not.toContain(input.content);

    const replay = await service.createFeedback(input);
    expect(replay).toEqual({ ok: true, value: expect.objectContaining({
      id: first.value.id,
      title: input.title,
      content: input.content,
      replayed: true,
    }) });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A, studentId: student.id } })).toBe(1);
  });

  it('同一请求编号的内容变化返回 VERSION_CONFLICT 且不增加记录', async () => {
    const student = await createStudentFixture(TEACHER_A, 'A05 冲突学生');
    const service = createService(fixedClock());
    const base = { teacherId: TEACHER_A, studentId: student.id, clientRequestId: 'a05-save-conflict', title: '原始标题', content: '原始正文' };
    const first = await service.createFeedback(base);
    expect(first.ok).toBe(true);
    const conflict = await service.createFeedback({ ...base, content: '变更正文' });
    expect(conflict).toEqual({ ok: false, error: expect.objectContaining({ code: 'VERSION_CONFLICT' }) });
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A, studentId: student.id } })).toBe(1);
  });

  it('缺少或超长请求编号只在入口拒绝，旧调用仍保持原有创建行为', async () => {
    const student = await createStudentFixture(TEACHER_A, 'A05 兼容学生');
    const service = createFeedbackService({ prisma, cipher });
    const missing = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, clientRequestId: '   ', title: '标题', content: '正文' });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'clientRequestId' }) });
    const legacy = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '旧调用', content: '正文' });
    expect(legacy).toEqual({ ok: true, value: expect.objectContaining({ title: '旧调用' }) });
    if (legacy.ok) expect(legacy.value).not.toHaveProperty('replayed');
    const row = await prisma.parentFeedback.findFirstOrThrow({ where: { teacherId: TEACHER_A, studentId: student.id } });
    expect(row.clientRequestId).toBeNull();
    expect(row.creationReceiptCiphertext).toBeNull();
  });
});
