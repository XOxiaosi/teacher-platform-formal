import { describe, it, expect, vi } from 'vitest';
import { err, internalError, ok } from '@teacher-platform/contracts';

import { prisma, TEACHER_A, TEACHER_B, createService, fixedClock, createStatusFixture, createStudentFixture, createFeedbackOrThrow } from './feedback-service.fixtures.js';
describe("feedbackService.updateFeedbackStatus", () => {


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
});
