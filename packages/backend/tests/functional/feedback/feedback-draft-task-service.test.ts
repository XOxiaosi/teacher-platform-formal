import { ok } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createFeedbackDraftTaskService } from '../../../src/features/feedback/feedback-draft-task-service.js';
import { feedbackRecordInclude, projectFeedbackEvidence } from '../../../src/features/feedback/feedback-evidence-resolver.js';
import { cipher, createService, createStudentFixture, prisma, seedAuthoritativeEvidence, TEACHER_A, TEACHER_B } from './feedback-service.fixtures.js';

const evidence = [{ id: 'record-1', type: 'record' as const, occurredAt: '2026-09-01T00:00:00.000Z', category: 'lesson_observation', summary: '正式事实', examName: null, subject: null, score: null, fullScore: null, previousScore: null, sourceVersion: 'v1', originalDeleted: false }];

function service() {
  const context = { execute: vi.fn(async ({ studentId }: { studentId: string }) => ok({ studentId, lessonIds: [], evidence, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z' })) };
  const generator = { execute: vi.fn(async ({ studentId }: { studentId: string }) => ok({ studentId, lessonIds: [], title: 'AI 标题', content: 'AI 正文', rationale: '依据真实记录', source: 'ai' as const, evidence, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z' })) };
  return { tasks: createFeedbackDraftTaskService({ prisma, cipher, context, generator }), context, generator };
}

describe('FeedbackDraftTask durable service', () => {
  it('加密保存、同 teacher 请求重放且不二次调用模型', async () => {
    const student = await createStudentFixture(TEACHER_A, '草稿学生'); const { tasks, generator } = service();
    const input = { teacherId: TEACHER_A, clientRequestId: 'draft-idempotent-1', studentId: student.id, recordIds: ['record-1'], title: '', content: '' };
    const first = await tasks.create(input); const replay = await tasks.create(input);
    expect(first.ok && first.value.replayed).toBe(false); expect(replay.ok && replay.value.replayed).toBe(true);
    expect(generator.execute).toHaveBeenCalledTimes(1);
    const row = await prisma.feedbackDraftTask.findUniqueOrThrow({ where: { teacherId_clientRequestId: { teacherId: TEACHER_A, clientRequestId: input.clientRequestId } } });
    expect(row.requestCiphertext).toMatch(/^enc:v1:/); expect(row.draftCiphertext).toMatch(/^enc:v1:/);
  });
  it('时间写入使用数据库可信时钟，不受应用时钟漂移影响', async () => {
    const student = await createStudentFixture(TEACHER_A, '可信时间学生'); const { tasks } = service();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    try {
      const created = await tasks.create({ teacherId: TEACHER_A, clientRequestId: 'draft-trusted-time-1', studentId: student.id });
      expect(created.ok).toBe(true); if (!created.ok) return;
      const row = await prisma.feedbackDraftTask.findUniqueOrThrow({ where: { id: created.value.task.id } });
      const attempt = await prisma.feedbackDraftAttempt.findUniqueOrThrow({ where: { taskId_clientRequestId: { taskId: row.id, clientRequestId: 'draft-trusted-time-1' } } });
      const dbNow = (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`)[0].now;
      expect(Math.abs(row.createdAtTs.getTime() - dbNow.getTime())).toBeLessThan(5000);
      expect(Math.abs(row.updatedAtTs.getTime() - dbNow.getTime())).toBeLessThan(5000);
      expect(Math.abs(attempt.createdAtTs.getTime() - dbNow.getTime())).toBeLessThan(5000);
      expect(Math.abs(attempt.updatedAtTs.getTime() - dbNow.getTime())).toBeLessThan(5000);
      expect(row.createdAtTs.getUTCFullYear()).toBeLessThan(2099);
      const updated = await tasks.updateDraft({ teacherId: TEACHER_A, taskId: row.id, expectedVersion: created.value.task.version,
        title: '教师标题', content: '教师正文' });
      expect(updated.ok).toBe(true); if (!updated.ok) return;
      expect(updated.value.updatedAt.getUTCFullYear()).toBeLessThan(2099);
    } finally {
      vi.useRealTimers();
    }
  });
  it('拒绝空白、重复或互斥的依据 ID，且不落库', async () => {
    const student = await createStudentFixture(TEACHER_A, '依据校验学生'); const { tasks } = service();
    const cases = [
      { clientRequestId: 'draft-invalid-empty', lessonIds: [] as string[] },
      { clientRequestId: 'draft-invalid-blank', recordIds: ['  '] },
      { clientRequestId: 'draft-invalid-duplicate', lessonIds: ['lesson-1', ' lesson-1 '] },
      { clientRequestId: 'draft-invalid-mutual', lessonIds: ['lesson-1'], recordIds: ['record-1'] },
    ];
    for (const value of cases) {
      const result = await tasks.create({ teacherId: TEACHER_A, studentId: student.id, ...value });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(await prisma.feedbackDraftTask.count({ where: { teacherId: TEACHER_A, clientRequestId: value.clientRequestId } })).toBe(0);
    }
  });
  it('跨教师读取任务统一为 NOT_FOUND', async () => {
    const student = await createStudentFixture(TEACHER_A, '隔离学生'); const { tasks } = service();
    const created = await tasks.create({ teacherId: TEACHER_A, clientRequestId: 'draft-owner-1', studentId: student.id });
    if (!created.ok) throw new Error(created.error.message);
    const crossed = await tasks.get({ teacherId: TEACHER_B, taskId: created.value.task.id });
    expect(crossed).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('陈旧未开始 attempt 转为 uncertain，允许后续恢复', async () => {
    const student = await createStudentFixture(TEACHER_A, '恢复学生'); const { tasks } = service();
    const old = new Date(Date.now() - 6 * 60 * 1000);
    const task = await prisma.feedbackDraftTask.create({ data: { teacherId: TEACHER_A, studentId: student.id, clientRequestId: 'draft-stale-1', requestFingerprint: 'hash', status: 'running', attemptCount: 1,
      requestCiphertext: cipher.encryptJson({ clientRequestId: 'draft-stale-1', studentId: student.id }), draftCiphertext: cipher.encryptJson({ title: '', content: '' }), createdAtTs: old, updatedAtTs: old } });
    await prisma.feedbackDraftAttempt.create({ data: { taskId: task.id, teacherId: TEACHER_A, clientRequestId: 'draft-stale-1', requestFingerprint: 'hash', status: 'running', createdAtTs: old, updatedAtTs: old } });
    const got = await tasks.get({ teacherId: TEACHER_A, taskId: task.id });
    expect(got).toMatchObject({ ok: true, value: { status: 'uncertain', retryable: true } });
  });
  it('running 任务遇到已结束 attempt 时转为 uncertain，不永久卡在 running', async () => {
    const student = await createStudentFixture(TEACHER_A, '不一致状态学生'); const { tasks, generator } = service();
    const old = new Date(Date.now() - 60 * 1000);
    const ended = new Date(Date.now() - 30 * 1000);
    const task = await prisma.feedbackDraftTask.create({ data: { teacherId: TEACHER_A, studentId: student.id, clientRequestId: 'draft-ended-attempt-1', requestFingerprint: 'hash', status: 'running', attemptCount: 1,
      requestCiphertext: cipher.encryptJson({ clientRequestId: 'draft-ended-attempt-1', studentId: student.id }), draftCiphertext: cipher.encryptJson({ title: '', content: '' }), createdAtTs: old, updatedAtTs: old } });
    await prisma.feedbackDraftAttempt.create({ data: { taskId: task.id, teacherId: TEACHER_A, clientRequestId: 'draft-ended-attempt-1', requestFingerprint: 'hash', status: 'succeeded', modelCallStartedAtTs: old, modelCallEndedAtTs: ended, createdAtTs: old, updatedAtTs: ended } });
    const got = await tasks.get({ teacherId: TEACHER_A, taskId: task.id });
    expect(got).toMatchObject({ ok: true, value: { status: 'uncertain', retryable: true } });
    if (!got.ok) return;
    const recovered = await tasks.retry({ teacherId: TEACHER_A, taskId: task.id, clientRequestId: 'draft-ended-attempt-retry', expectedVersion: got.value.version });
    expect(recovered).toMatchObject({ ok: true, value: { task: { status: 'succeeded' }, replayed: false } });
    expect(generator.execute).toHaveBeenCalledTimes(1);
  });
  it('旧 attempt 晚到结果不能覆盖重试后的新草稿', async () => {
    const student = await createStudentFixture(TEACHER_A, '并发恢复学生');
    let invocation = 0;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const context = { execute: vi.fn(async ({ studentId }: { studentId: string }) => ok({ studentId, lessonIds: [], evidence, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z' })) };
    const generator = { execute: vi.fn(async ({ studentId }: { studentId: string }) => {
      const call = ++invocation;
      if (call === 1) await oldGate;
      return ok({ studentId, lessonIds: [], title: call === 1 ? '旧标题' : '新标题', content: call === 1 ? '旧正文' : '新正文', rationale: '依据真实记录', source: 'ai' as const, evidence, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z' });
    }) };
    const tasks = createFeedbackDraftTaskService({ prisma, cipher, context, generator });

    const original = tasks.create({ teacherId: TEACHER_A, clientRequestId: 'draft-late-original', studentId: student.id });
    await vi.waitFor(() => expect(generator.execute).toHaveBeenCalledTimes(1));
    const task = await prisma.feedbackDraftTask.findUniqueOrThrow({ where: { teacherId_clientRequestId: { teacherId: TEACHER_A, clientRequestId: 'draft-late-original' } } });
    const originalAttempt = await prisma.feedbackDraftAttempt.findUniqueOrThrow({ where: { taskId_clientRequestId: { taskId: task.id, clientRequestId: 'draft-late-original' } } });
    await prisma.feedbackDraftAttempt.update({ where: { id: originalAttempt.id }, data: { modelCallStartedAtTs: new Date(Date.now() - 6 * 60 * 1000) } });

    const uncertain = await tasks.get({ teacherId: TEACHER_A, taskId: task.id });
    if (!uncertain.ok) throw new Error(uncertain.error.message);
    expect(uncertain.value).toMatchObject({ status: 'uncertain', retryable: true });
    const retried = await tasks.retry({ teacherId: TEACHER_A, taskId: task.id, clientRequestId: 'draft-late-retry', expectedVersion: uncertain.value.version });
    expect(retried).toMatchObject({ ok: true, value: { task: { status: 'succeeded', draft: { title: '新标题', content: '新正文' } } } });

    releaseOld();
    await original;
    const final = await tasks.get({ teacherId: TEACHER_A, taskId: task.id });
    expect(final).toMatchObject({ ok: true, value: { status: 'succeeded', draft: { title: '新标题', content: '新正文' }, attemptCount: 2 } });
    expect(await prisma.feedbackDraftAttempt.findUniqueOrThrow({ where: { id: originalAttempt.id } })).toMatchObject({ status: 'uncertain', modelCallEndedAtTs: null });
    expect(await prisma.feedbackDraftAttempt.findUniqueOrThrow({ where: { taskId_clientRequestId: { taskId: task.id, clientRequestId: 'draft-late-retry' } } })).toMatchObject({ status: 'succeeded' });
  });
  it('保存 generationTask 时只采用任务依据和课程语义，并原子标记 saved', async () => {
    const student = await createStudentFixture(TEACHER_A, '保存学生');
    await seedAuthoritativeEvidence(student.id, TEACHER_A, evidence);
    const record = await prisma.studentRecord.findUniqueOrThrow({ where: { id: 'record-1' }, include: feedbackRecordInclude });
    const taskEvidence = [projectFeedbackEvidence(record, cipher)];
    const task = await prisma.feedbackDraftTask.create({ data: { teacherId: TEACHER_A, studentId: student.id, clientRequestId: 'draft-save-1', requestFingerprint: 'hash', status: 'succeeded', attemptCount: 1,
      requestCiphertext: cipher.encryptJson({ clientRequestId: 'draft-save-1', studentId: student.id }), draftCiphertext: cipher.encryptJson({ title: '任务标题', content: '任务正文' }),
      generationCiphertext: cipher.encryptJson({ lessonIds: [], evidence: taskEvidence, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z', rationale: '任务依据' }) } });
    const saved = await createService().createFeedback({ teacherId: TEACHER_A, studentId: student.id, generationTaskId: task.id, clientRequestId: 'save-task-1',
      lessonId: 'client-must-be-ignored', title: '教师最终标题', content: '教师最终正文', evidence: [{ ...evidence[0], id: 'forged-record' }], windowStart: '2025-01-01T00:00:00.000Z', windowEnd: '2025-01-02T00:00:00.000Z' });
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    expect(saved.value.lessonId).toBeNull();
    const persisted = await prisma.feedbackDraftTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(persisted).toMatchObject({ status: 'saved', savedFeedbackId: saved.value.id });
    expect(persisted.updatedAtTs.toISOString()).toBe(saved.value.createdAt.toISOString());
    const snapshot = await prisma.feedbackContextSnapshot.findUniqueOrThrow({ where: { feedbackId: saved.value.id } });
    expect(snapshot.windowStartTs?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(await prisma.feedbackEvidence.count({ where: { snapshotId: snapshot.id, recordId: 'record-1' } })).toBe(1);
    const replay = await createService().createFeedback({ teacherId: TEACHER_A, studentId: student.id, generationTaskId: task.id, clientRequestId: 'save-task-1', title: '教师最终标题', content: '教师最终正文' });
    expect(replay).toMatchObject({ ok: true, value: { id: saved.value.id, replayed: true } });
    expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(1);
  });
});
