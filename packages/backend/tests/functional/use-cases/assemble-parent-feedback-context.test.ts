import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';

const prisma = new PrismaClient();
const useCase = createAssembleParentFeedbackContextUseCase({ prisma });

const TEACHER_A = 'test-teacher-fb-ctx-a';
const TEACHER_B = 'test-teacher-fb-ctx-b';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function cleanup() {
  const teacherIds = { in: [TEACHER_A, TEACHER_B] };
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.lesson.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.schedule.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.student.deleteMany({ where: { teacherId: teacherIds } });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

function daysAgo(days: number, base: Date): Date {
  return new Date(base.getTime() - days * MS_PER_DAY);
}

async function createStudent(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test', stageGoal: '进步' },
  });
}

async function createAssessmentRecord(opts: {
  teacherId: string;
  studentId: string;
  occurredAt: Date;
  summary: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  previousScore?: number;
  reviewStatus?: string;
  visibility?: string;
  supersedesId?: string | null;
}) {
  const record = await prisma.studentRecord.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      category: 'assessment',
      occurredAtTs: opts.occurredAt,
      summary: opts.summary,
      reviewStatus: opts.reviewStatus ?? 'confirmed',
      visibility: opts.visibility ?? 'parent_shareable',
      importance: 'normal',
      supersedesId: opts.supersedesId ?? null,
    },
  });
  if (opts.examName || opts.subject || opts.score !== undefined) {
    await prisma.assessmentDetail.create({
      data: {
        teacherId: opts.teacherId,
        studentRecordId: record.id,
        examName: opts.examName ?? null,
        subject: opts.subject ?? null,
        score: opts.score ?? null,
        fullScore: opts.fullScore ?? null,
        previousScore: opts.previousScore ?? null,
      },
    });
  }
  return record;
}

async function createOtherRecord(opts: {
  teacherId: string;
  studentId: string;
  category: string;
  summary: string;
  occurredAt: Date;
  importance?: string;
  reviewStatus?: string;
  visibility?: string;
  supersedesId?: string | null;
}) {
  return prisma.studentRecord.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      category: opts.category,
      occurredAtTs: opts.occurredAt,
      summary: opts.summary,
      reviewStatus: opts.reviewStatus ?? 'confirmed',
      visibility: opts.visibility ?? 'parent_shareable',
      importance: opts.importance ?? 'normal',
      supersedesId: opts.supersedesId ?? null,
    },
  });
}

async function createLesson(opts: {
  teacherId: string;
  studentId: string;
  date: Date;
  progress?: string;
  studentState?: string;
  teacherNote?: string;
  homework?: string;
}) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      type: 'lesson',
      title: 'test',
      scheduledStartTs: opts.date,
      scheduledEndTs: new Date(opts.date.getTime() + 60 * 60 * 1000),
    },
  });
  return prisma.lesson.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      scheduleId: schedule.id,
      dateTs: opts.date,
      status: 'attended',
      progress: opts.progress ?? null,
      studentState: opts.studentState ?? null,
      teacherNote: opts.teacherNote ?? null,
      homework: opts.homework ?? null,
    },
  });
}

describe('assembleParentFeedbackContext', () => {
  it('无历史反馈：windowStart ≈ now-30天', async () => {
    const student = await createStudent(TEACHER_A, '小明');
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const windowStart = new Date(result.value.windowStart).getTime();
    const windowEnd = new Date(result.value.windowEnd).getTime();
    expect(windowEnd).toBeGreaterThan(windowStart);
    // 大约 30 天，容差 5 秒
    const diffDays = (windowEnd - windowStart) / MS_PER_DAY;
    expect(diffDays).toBeGreaterThan(29.99);
    expect(diffDays).toBeLessThan(30.01);
  });

  it('有 sent 反馈：windowStart = sentAtTs', async () => {
    const student = await createStudent(TEACHER_A, '小红');
    const now = new Date();
    const sentAt = daysAgo(10, now);
    await prisma.parentFeedback.create({
      data: {
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '旧反馈',
        content: '内容',
        status: 'sent',
        sentAtTs: sentAt,
      },
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const windowStart = new Date(result.value.windowStart).getTime();
    expect(Math.abs(windowStart - sentAt.getTime())).toBeLessThan(1000);
  });

  it('有 reviewed 反馈：windowStart = updatedAtTs（sentAtTs 为 null）', async () => {
    const student = await createStudent(TEACHER_A, '小绿');
    const feedback = await prisma.parentFeedback.create({
      data: {
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '审核中',
        content: '内容',
        status: 'reviewed',
        sentAtTs: null,
      },
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const windowStart = new Date(result.value.windowStart).getTime();
    expect(Math.abs(windowStart - feedback.updatedAtTs.getTime())).toBeLessThan(1000);
  });

  it('100天前的反馈：windowStart 被钳制到 now-90天', async () => {
    const student = await createStudent(TEACHER_A, '小蓝');
    const now = new Date();
    const sentAt = daysAgo(100, now);
    await prisma.parentFeedback.create({
      data: {
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '很旧',
        content: '内容',
        status: 'sent',
        sentAtTs: sentAt,
      },
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const windowStart = new Date(result.value.windowStart).getTime();
    const windowEnd = new Date(result.value.windowEnd).getTime();
    const diffDays = (windowEnd - windowStart) / MS_PER_DAY;
    expect(diffDays).toBeGreaterThan(89.99);
    expect(diffDays).toBeLessThan(90.01);
  });

  it('只收 confirmed + parent_shareable；被取代旧记录排除、改正后的当前记录纳入', async () => {
    const student = await createStudent(TEACHER_A, '小紫');
    const now = new Date();
    const d5 = daysAgo(5, now);

    await createOtherRecord({ teacherId: TEACHER_A, studentId: student.id, category: 'concern', summary: '候选', occurredAt: d5, reviewStatus: 'candidate' });
    await createOtherRecord({ teacherId: TEACHER_A, studentId: student.id, category: 'concern', summary: '内部', occurredAt: d5, visibility: 'internal_only' });
    await createOtherRecord({ teacherId: TEACHER_A, studentId: student.id, category: 'concern', summary: '待审', occurredAt: d5, visibility: 'needs_review' });

    // 真实取代语义：旧记录 reviewStatus='superseded'（supersedesId 保持 null）；新记录 supersedesId 指向旧记录。
    const oldSuperseded = await createOtherRecord({ teacherId: TEACHER_A, studentId: student.id, category: 'concern', summary: '旧记录（被取代）', occurredAt: daysAgo(8, now), reviewStatus: 'superseded' });
    const currentReplacement = await createOtherRecord({ teacherId: TEACHER_A, studentId: student.id, category: 'concern', summary: '改正后的当前记录', occurredAt: d5, supersedesId: oldSuperseded.id });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const recordIds = result.value.evidence.filter((e) => e.type === 'record').map((e) => e.id);
    // 改正后的当前记录（supersedesId 非 null）必须纳入——否则纠正过的成绩永远进不了反馈
    expect(recordIds).toContain(currentReplacement.id);
    // 被取代的旧记录排除（reviewStatus='superseded'）
    expect(recordIds).not.toContain(oldSuperseded.id);
    // 被排除：候选 / 内部 / 待审 / 被取代的旧记录 —— 共 4 条排除，保留 1 条（改正后的当前记录）
    expect(recordIds).toHaveLength(1);
  });

  it('成绩最多 3 条', async () => {
    const student = await createStudent(TEACHER_A, '小金');
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await createAssessmentRecord({
        teacherId: TEACHER_A,
        studentId: student.id,
        occurredAt: daysAgo(i + 1, now),
        summary: `考试 ${i + 1}`,
        examName: `月考${i + 1}`,
        subject: '物理',
        score: 80 + i,
        fullScore: 100,
      });
    }

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assessments = result.value.evidence.filter((e) => e.type === 'assessment');
    expect(assessments).toHaveLength(3);
    // 按 occurredAt desc 排序
    for (let i = 0; i < assessments.length - 1; i++) {
      expect(assessments[i].occurredAt >= assessments[i + 1].occurredAt).toBe(true);
    }
  });

  it('其他记录超 20 截断', async () => {
    const student = await createStudent(TEACHER_A, '小橙');
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      await createOtherRecord({
        teacherId: TEACHER_A,
        studentId: student.id,
        category: 'learning_state',
        summary: `记录 ${i + 1}`,
        occurredAt: daysAgo(i + 1, now),
      });
    }

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const records = result.value.evidence.filter((e) => e.type === 'record');
    expect(records.length).toBeLessThanOrEqual(20);
  });

  it('原始课程不直接成为可分享事实', async () => {
    const student = await createStudent(TEACHER_A, '小粉');
    const now = new Date();
    for (let i = 0; i < 8; i++) {
      await createLesson({
        teacherId: TEACHER_A,
        studentId: student.id,
        date: daysAgo(i + 1, now),
        progress: `第 ${i + 1} 课`,
      });
    }

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lessons = result.value.evidence.filter((e) => e.type === 'lesson');
    expect(lessons).toHaveLength(0);
  });

  it('重要问题：60天前 importance=important 被纳入，normal 同龄不纳入', async () => {
    const student = await createStudent(TEACHER_A, '小灰');
    const now = new Date();

    // 确保 windowStart = 30天前（无历史反馈）
    const important = await createOtherRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      category: 'concern',
      summary: '重要问题',
      occurredAt: daysAgo(60, now),
      importance: 'important',
    });
    const normal = await createOtherRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      category: 'learning_state',
      summary: '普通记录',
      occurredAt: daysAgo(60, now),
      importance: 'normal',
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const recordIds = result.value.evidence.filter((e) => e.type === 'record').map((e) => e.id);
    expect(recordIds).toContain(important.id);
    expect(recordIds).not.toContain(normal.id);
  });

  it('成绩 detail 关联正确：examName/subject/score/fullScore/previousScore', async () => {
    const student = await createStudent(TEACHER_A, '小棕');
    const now = new Date();
    await createAssessmentRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAt: daysAgo(5, now),
      summary: '期中物理',
      examName: '期中考试',
      subject: '物理',
      score: 85,
      fullScore: 100,
      previousScore: 78,
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assessment = result.value.evidence.find((e) => e.type === 'assessment');
    expect(assessment).toBeDefined();
    expect(assessment!.examName).toBe('期中考试');
    expect(assessment!.subject).toBe('物理');
    expect(assessment!.score).toBe(85);
    expect(assessment!.fullScore).toBe(100);
    expect(assessment!.previousScore).toBe(78);
    expect(assessment!.category).toBe('assessment');
  });

  it('无 detail 的成绩记录仍保留（字段 null）', async () => {
    const student = await createStudent(TEACHER_A, '小虾');
    const now = new Date();
    await createAssessmentRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAt: daysAgo(3, now),
      summary: '未录入明细的成绩',
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assessment = result.value.evidence.find((e) => e.type === 'assessment');
    expect(assessment).toBeDefined();
    expect(assessment!.examName).toBeNull();
    expect(assessment!.subject).toBeNull();
    expect(assessment!.score).toBeNull();
  });

  it('未明确分享的课程摘要不能进入反馈依据', async () => {
    const student = await createStudent(TEACHER_A, '小蟹');
    const now = new Date();
    await createLesson({
      teacherId: TEACHER_A,
      studentId: student.id,
      date: daysAgo(2, now),
      progress: '进度内容',
    });
    await createLesson({
      teacherId: TEACHER_A,
      studentId: student.id,
      date: daysAgo(5, now),
      studentState: '状态好',
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lessons = result.value.evidence.filter((e) => e.type === 'lesson');
    expect(lessons).toHaveLength(0);
    const bySummary = new Map(lessons.map((l) => [l.summary, l]));
    expect(bySummary.get('进度内容')).toBeUndefined();
    expect(bySummary.get('状态好')).toBeUndefined();
  });

  it('evidence 按 occurredAt desc 排序，id 唯一去重', async () => {
    const student = await createStudent(TEACHER_A, '小贝');
    const now = new Date();
    await createAssessmentRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAt: daysAgo(5, now),
      summary: '成绩',
      examName: '单元测',
      subject: '数学',
      score: 90,
      fullScore: 100,
    });
    await createOtherRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      category: 'homework',
      summary: '作业',
      occurredAt: daysAgo(2, now),
    });
    await createLesson({
      teacherId: TEACHER_A,
      studentId: student.id,
      date: daysAgo(1, now),
      progress: '上课',
    });

    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { evidence } = result.value;
    expect(evidence).toHaveLength(2);
    expect(evidence.map(item => item.summary)).toEqual(['作业', '成绩']);
    // 排序校验
    for (let i = 0; i < evidence.length - 1; i++) {
      expect(evidence[i].occurredAt >= evidence[i + 1].occurredAt).toBe(true);
    }
    // id 唯一
    const ids = evidence.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('owner 隔离：跨 teacher → NOT_FOUND', async () => {
    const student = await createStudent(TEACHER_A, '小派');
    const result = await useCase.execute({ teacherId: TEACHER_B, studentId: student.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('学生不存在 → NOT_FOUND', async () => {
    const result = await useCase.execute({ teacherId: TEACHER_A, studentId: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});
