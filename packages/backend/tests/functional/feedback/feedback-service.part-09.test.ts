import { describe, it, expect } from 'vitest';

import { TEACHER_A, TEACHER_B, createService, fixedClock, seedAuthoritativeEvidence, createStudentFixture } from './feedback-service.fixtures.js';
describe("feedbackService.getFeedbackSnapshot", () => {

  async function createSnapshotFeedback(teacherId = TEACHER_A) {
    const student = await createStudentFixture(teacherId, '快照查询学生');
    const clock = fixedClock(new Date('2031-05-06T07:08:09.123Z'));
    const evidence = [
      {
        id: 'rec-1',
        type: 'assessment' as const,
        occurredAt: '2026-01-15T10:00:00Z',
        category: 'assessment',
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
    await seedAuthoritativeEvidence(student.id, teacherId, evidence);
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
    expect(result.value.evidence[0].category).toBe('assessment');
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
