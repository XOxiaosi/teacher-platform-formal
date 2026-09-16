import { describe, it, expect, vi } from 'vitest';

import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import { encryptFieldValue } from '../../../src/shared/field-encryption/index.js';
import { cipher, prisma, TEACHER_A, createService, moderationAdapter, loggerSpy, fixedClock, createStatusFixture, createStudentFixture } from './feedback-service.fixtures.js';
describe("feedbackService.updateFeedbackStatus / reviewed -> sent 本地出站审核", () => {


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
