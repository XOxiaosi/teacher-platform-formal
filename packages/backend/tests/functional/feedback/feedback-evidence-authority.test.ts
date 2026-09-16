import { describe, it, expect } from 'vitest';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import { resolveFeedbackEvidence } from '../../../src/features/feedback/feedback-evidence-resolver.js';
import { createChangelogService } from '../../../src/shared/changelog/index.js';
import { encryptFieldValue, decryptFieldValue } from '../../../src/shared/field-encryption/index.js';
import { prisma, cipher, TEACHER_A, TEACHER_B, createStudentFixture } from './feedback-service.fixtures.js';

const service = createFeedbackService({ prisma, cipher });
async function fixture() {
  const student = await createStudentFixture(TEACHER_A, '依据边界合成学生');
  const record = await prisma.studentRecord.create({ data: { teacherId: TEACHER_A, studentId: student.id,
    category: 'assessment', summary: encryptFieldValue(cipher, '权威数学测验得分 82'),
    occurredAtTs: new Date(), reviewStatus: 'confirmed', visibility: 'parent_shareable',
    assessment: { create: { teacherId: TEACHER_A, examName: '本周测验', subject: '数学', score: 82 } } } });
  const resolved = await resolveFeedbackEvidence({ client: prisma, teacherId: TEACHER_A, studentId: student.id,
    references: [{ id: record.id, type: 'assessment' }], cipher });
  if (!resolved.ok) throw new Error('fixture admission failed');
  return { student, record, reference: resolved.value[0] };
}
async function emptyWrites() {
  expect(await prisma.parentFeedback.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  expect(await prisma.feedbackContextSnapshot.count({ where: { teacherId: TEACHER_A } })).toBe(0);
  expect(await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_A } })).toBe(0);
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('A05 authoritative feedback evidence', () => {
  it('ignores forged client fact fields and persists decrypted server facts encrypted', async () => {
    const { student, reference } = await fixture();
    const result = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '教师编辑的内容',
      evidence: [{ ...reference, summary: '伪造的满分', score: 100, examName: '伪造考试', occurredAt: '2001-01-01T00:00:00Z' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const evidence = await prisma.feedbackEvidence.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(evidence.score).toBe(82);
    expect(evidence.examName).toBe('本周测验');
    expect(evidence.occurredAtTs.toISOString()).toBe(reference.occurredAt);
    expect(evidence.summary).not.toBe(reference.summary);
    expect(decryptFieldValue(cipher, evidence.summary!)).toBe(reference.summary);
    const snapshot = await service.getFeedbackSnapshot({ teacherId: TEACHER_A, feedbackId: result.value.id });
    expect(snapshot.ok && snapshot.value?.evidence[0]?.summary).toBe(reference.summary);
  });

  it.each([
    { reviewStatus: 'candidate' }, { reviewStatus: 'superseded' }, { reviewStatus: 'rejected' },
    { visibility: 'internal_only' }, { visibility: 'needs_review' }, { teacherId: TEACHER_B },
  ])('rejects current invalid or foreign source %j with no partial writes', async mutation => {
    const { student, record, reference } = await fixture();
    await prisma.studentRecord.update({ where: { id: record.id }, data: mutation });
    const result = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence: [reference] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VERSION_CONFLICT');
    await emptyWrites();
  });

  it.each(['missing', 'duplicate', 'lesson', 'idless', 'wrong-type'] as const)('rejects %s references', async mode => {
    const { student, reference } = await fixture();
    const evidence = mode === 'duplicate' ? [reference, reference] : [{ ...reference,
      id: mode === 'missing' ? 'not-a-source' : mode === 'idless' ? undefined : reference.id,
      type: mode === 'lesson' ? 'lesson' as const : mode === 'wrong-type' ? 'record' as const : reference.type }];
    const result = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence });
    expect(result.ok).toBe(false);
    await emptyWrites();
  });

  it.each(['summary', 'score', 'association'] as const)('rejects stale generation fingerprint after %s changes', async field => {
    const { student, record, reference } = await fixture();
    if (field === 'score') await prisma.assessmentDetail.update({ where: { studentRecordId: record.id }, data: { score: 83 } });
    else await prisma.studentRecord.update({ where: { id: record.id }, data: field === 'summary'
      ? { summary: encryptFieldValue(cipher, '更正后的事实') } : { structuredData: { lessonId: 'changed' } } });
    const result = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence: [reference] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VERSION_CONFLICT');
    await emptyWrites();
  });

  it('raw source deletion preserves formal evidence and never restores raw text', async () => {
    const { student, record } = await fixture();
    const source = await prisma.studentSourceRecord.create({ data: { teacherId: TEACHER_A, studentId: student.id,
      sourceType: 'manual', occurredAtTs: new Date(), rawText: '原始内部材料' } });
    try {
      await prisma.studentRecord.update({ where: { id: record.id }, data: { sourceRecordId: source.id } });
      const before = await resolveFeedbackEvidence({ client: prisma, teacherId: TEACHER_A, studentId: student.id,
        references: [{ id: record.id, type: 'assessment' }], cipher });
      if (!before.ok) throw new Error('expected source');
      await prisma.studentSourceRecord.update({ where: { id: source.id }, data: { rawText: null, captureStatus: 'deleted' } });
      const after = await resolveFeedbackEvidence({ client: prisma, teacherId: TEACHER_A, studentId: student.id, references: before.value, cipher });
      expect(after.ok && after.value[0].originalDeleted).toBe(true);
      expect(after.ok && after.value[0].sourceVersion).toBe(before.value[0].sourceVersion);
      const saved = await service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence: before.value });
      expect(saved.ok).toBe(true);
      expect(JSON.stringify(after)).not.toContain('原始内部材料');
      expect((await prisma.studentSourceRecord.findUniqueOrThrow({ where: { id: source.id } })).rawText).toBeNull();
    } finally {
      await prisma.studentRecord.update({ where: { id: record.id }, data: { sourceRecordId: null } });
      await prisma.studentSourceRecord.delete({ where: { id: source.id } });
    }
  });

  it('waits for concurrent revocation then re-reads before saving', async () => {
    const { student, record, reference } = await fixture();
    const locked = deferred(); const release = deferred();
    const revoke = prisma.$transaction(async tx => {
      await tx.studentRecord.update({ where: { id: record.id }, data: { visibility: 'internal_only' } });
      locked.release(); await release.promise;
    });
    await locked.promise;
    const saving = service.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence: [reference] });
    release.release(); await revoke;
    expect((await saving).ok).toBe(false);
    await emptyWrites();
  });

  it('keeps authority locked through snapshot and audit commit', async () => {
    const { student, record, reference } = await fixture();
    const reached = deferred(); const release = deferred();
    const lockedService = createFeedbackService({ prisma, cipher, changelogFactory: tx => ({ async recordChange(input) {
      reached.release(); await release.promise;
      return createChangelogService(tx, cipher).recordChange(input);
    } }) });
    const saving = lockedService.createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '草稿', content: '内容', evidence: [reference] });
    await reached.promise;
    // NOWAIT is deterministic evidence that the source remains locked at the audit boundary.
    await expect(prisma.$transaction(tx => tx.$queryRaw`SELECT "id" FROM "StudentRecord" WHERE "id" = ${record.id} FOR UPDATE NOWAIT`)).rejects.toThrow();
    await expect(prisma.$transaction(tx => tx.$queryRaw`SELECT "id" FROM "AssessmentDetail" WHERE "studentRecordId" = ${record.id} FOR UPDATE NOWAIT`)).rejects.toThrow();
    release.release();
    expect((await saving).ok).toBe(true);
    expect(await prisma.feedbackEvidence.count({ where: { teacherId: TEACHER_A } })).toBe(1);
  });
});
