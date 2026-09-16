import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import { cipher, prisma, TEACHER_A, createService, fixedClock, seedAuthoritativeEvidence, createStudentFixture } from './feedback-service.fixtures.js';
describe("feedbackService.createFeedback with evidence snapshot", () => {


  it('带 evidence 时，反馈 + 快照 + evidence 明细同事务原子落库，字段 roundtrip 正确', async () => {
    const student = await createStudentFixture(TEACHER_A, '快照学生');
    const token = new Date('2031-03-04T05:06:07.123Z');
    const clock = fixedClock(token);

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
        parentConcerns: ['解题步骤不规范', '粗心失分'],
        followUps: ['加强错题本练习'],
      },
      {
        id: 'lesson-1',
        type: 'record' as const,
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
        id: 'rec-3',
        type: 'record' as const,
        occurredAt: '2026-02-01T00:00:00Z',
        summary: '家长主动沟通',
      },
    ];

    await seedAuthoritativeEvidence(student.id, TEACHER_A, evidence);
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
    expect(records[0].category).toBe('assessment');
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
    expect(records[1].type).toBe('record');
    expect(records[1].recordId).toBe('lesson-1');
    expect(records[1].occurredAtTs).toEqual(new Date('2026-01-20T06:00:00.000Z'));
    expect(records[1].parentConcerns).toEqual([]);
    expect(records[1].followUps).toEqual([]);

    expect(records[2].sortOrder).toBe(2);
    expect(records[2].type).toBe('record');
    expect(records[2].recordId).toBe('rec-3');
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
    await seedAuthoritativeEvidence(student.id, TEACHER_A, [{ id: 'atomicity-evidence', type: 'assessment', occurredAt: '2026-01-01T00:00:00Z', score: 95 }]);
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
        { id: 'atomicity-evidence', type: 'assessment', occurredAt: '2026-01-01T00:00:00Z', score: 95 },
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
