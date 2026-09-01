import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';

const prisma = new PrismaClient();
const service = createStudentTimelineService(prisma);

const TEACHER_A = 'test-teacher-timeline-a';
const TEACHER_B = 'test-teacher-timeline-b';

async function cleanup() {
  await prisma.communicationDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}

function createStudent(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
}

function createRecord(input: {
  teacherId: string;
  studentId: string;
  occurredAtTs: Date;
  summary: string;
  category?: string;
  reviewStatus?: string;
}) {
  return prisma.studentRecord.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      category: input.category ?? 'general_note',
      occurredAtTs: input.occurredAtTs,
      summary: input.summary,
      reviewStatus: input.reviewStatus ?? 'candidate',
      visibility: 'needs_review',
    },
  });
}

function createAssessment(input: {
  teacherId: string;
  studentRecordId: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
}) {
  return prisma.assessmentDetail.create({
    data: {
      teacherId: input.teacherId,
      studentRecordId: input.studentRecordId,
      examName: input.examName ?? null,
      subject: input.subject ?? null,
      score: input.score ?? null,
      fullScore: input.fullScore ?? null,
    },
  });
}

async function createLesson(input: {
  teacherId: string;
  studentId: string;
  dateTs: Date;
  status?: string;
  progress?: string;
  teacherNote?: string;
}) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      type: 'lesson',
      title: '时间线课程',
      scheduledStartTs: input.dateTs,
      scheduledEndTs: new Date(input.dateTs.getTime() + 90 * 60 * 1000),
    },
  });
  return prisma.lesson.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      scheduleId: schedule.id,
      dateTs: input.dateTs,
      status: input.status ?? 'attended',
      progress: input.progress ?? null,
      teacherNote: input.teacherNote ?? null,
    },
  });
}

function createFeedback(input: {
  teacherId: string;
  studentId: string;
  title: string;
  content: string;
  status?: string;
  sentAtTs?: Date | null;
}) {
  return prisma.parentFeedback.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      title: input.title,
      content: input.content,
      status: input.status ?? 'draft',
      sentAtTs: input.sentAtTs ?? null,
    },
  });
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('studentTimelineService.getStudentTimeline', () => {
  it('合并 record/assessment/lesson/feedback，按 occurredAt desc 排序并映射字段', async () => {
    const student = await createStudent(TEACHER_A, '张三');

    const record = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-01-01T00:00:00Z'),
      summary: '课堂表现专注',
      category: 'lesson_observation',
      reviewStatus: 'confirmed',
    });

    const assessmentRecord = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-01-02T00:00:00Z'),
      summary: '期中数学成绩',
      category: 'assessment',
      reviewStatus: 'confirmed',
    });
    await createAssessment({
      teacherId: TEACHER_A,
      studentRecordId: assessmentRecord.id,
      examName: '期中考试',
      subject: '数学',
      score: 88,
      fullScore: 100,
    });

    const lesson = await createLesson({
      teacherId: TEACHER_A,
      studentId: student.id,
      dateTs: new Date('2026-01-03T00:00:00Z'),
      status: 'attended',
      progress: '复习函数',
    });

    const feedback = await createFeedback({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '家长反馈',
      content: '孩子进步明显',
      status: 'sent',
      sentAtTs: new Date('2026-01-04T00:00:00Z'),
    });

    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(4);
    expect(result.value.items.map((item) => item.type)).toEqual([
      'feedback',
      'lesson',
      'assessment',
      'record',
    ]);

    const [feedbackEntry, lessonEntry, assessmentEntry, recordEntry] = result.value.items;

    expect(feedbackEntry.id).toBe(feedback.id);
    expect(feedbackEntry.occurredAt).toEqual(new Date('2026-01-04T00:00:00Z'));
    expect(feedbackEntry.title).toBe('家长反馈');
    expect(feedbackEntry.summary).toBe('孩子进步明显');
    expect(feedbackEntry.status).toBe('sent');
    expect(feedbackEntry.category).toBeNull();
    expect(feedbackEntry.score).toBeNull();

    expect(lessonEntry.id).toBe(lesson.id);
    expect(lessonEntry.occurredAt).toEqual(new Date('2026-01-03T00:00:00Z'));
    expect(lessonEntry.title).toBe(`课次 ${lesson.dateTs}`);
    expect(lessonEntry.summary).toBe('复习函数');
    expect(lessonEntry.status).toBe('attended');
    expect(lessonEntry.category).toBeNull();

    expect(assessmentEntry.id).toBe(assessmentRecord.id);
    expect(assessmentEntry.occurredAt).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(assessmentEntry.title).toBe('数学 期中考试');
    expect(assessmentEntry.summary).toBe('期中考试 / 数学 / 88');
    expect(assessmentEntry.category).toBe('assessment');
    expect(assessmentEntry.reviewStatus).toBe('confirmed');
    expect(assessmentEntry.score).toBe(88);
    expect(assessmentEntry.fullScore).toBe(100);
    expect(assessmentEntry.examName).toBe('期中考试');
    expect(assessmentEntry.subject).toBe('数学');
    expect(assessmentEntry.status).toBeNull();

    expect(recordEntry.id).toBe(record.id);
    expect(recordEntry.occurredAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(recordEntry.title).toBe('课堂表现专注');
    expect(recordEntry.summary).toBe('课堂表现专注');
    expect(recordEntry.category).toBe('lesson_observation');
    expect(recordEntry.reviewStatus).toBe('confirmed');
    expect(recordEntry.status).toBeNull();
    expect(recordEntry.score).toBeNull();
  });

  it('过滤 reviewStatus=superseded 的记录及其 assessment', async () => {
    const student = await createStudent(TEACHER_A, '李四');

    const kept = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-02-01T00:00:00Z'),
      summary: '保留记录',
      reviewStatus: 'confirmed',
    });

    await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-02-02T00:00:00Z'),
      summary: '被取代记录',
      reviewStatus: 'superseded',
    });

    const supersededAssessmentRecord = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-02-03T00:00:00Z'),
      summary: '被取代成绩',
      category: 'assessment',
      reviewStatus: 'superseded',
    });
    await createAssessment({
      teacherId: TEACHER_A,
      studentRecordId: supersededAssessmentRecord.id,
      examName: '旧考试',
      subject: '英语',
      score: 60,
    });

    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].id).toBe(kept.id);
    expect(result.value.items[0].type).toBe('record');
  });

  it('owner 校验：其他 teacher 的学生返回 NOT_FOUND', async () => {
    const otherStudent = await createStudent(TEACHER_B, '其他老师学生');

    const result = await service.getStudentTimeline({
      teacherId: TEACHER_A,
      studentId: otherStudent.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toBe('学生不存在');
  });

  it('跨 teacher 的记录不进入该学生时间线', async () => {
    const student = await createStudent(TEACHER_A, '我的学生');

    const mine = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-03-01T00:00:00Z'),
      summary: '我的记录',
    });

    await createRecord({
      teacherId: TEACHER_B,
      studentId: student.id,
      occurredAtTs: new Date('2026-03-02T00:00:00Z'),
      summary: '跨老师异常记录',
    });

    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].id).toBe(mine.id);
  });

  it('不混入其他老师学生的记录', async () => {
    const myStudent = await createStudent(TEACHER_A, '我的学生');
    const otherStudent = await createStudent(TEACHER_B, '别人的学生');

    const mine = await createRecord({
      teacherId: TEACHER_A,
      studentId: myStudent.id,
      occurredAtTs: new Date('2026-04-01T00:00:00Z'),
      summary: '我的记录',
    });

    await createRecord({
      teacherId: TEACHER_B,
      studentId: otherStudent.id,
      occurredAtTs: new Date('2026-04-02T00:00:00Z'),
      summary: '别人的记录',
    });

    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: myStudent.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].id).toBe(mine.id);
  });

  it('limit 截断：返回前 limit 条，total 为过滤后的全部条数', async () => {
    const student = await createStudent(TEACHER_A, '截断学生');

    for (let i = 0; i < 5; i += 1) {
      await createRecord({
        teacherId: TEACHER_A,
        studentId: student.id,
        occurredAtTs: new Date(Date.UTC(2026, 0, 1 + i)),
        summary: `记录${i}`,
      });
    }

    const result = await service.getStudentTimeline({
      teacherId: TEACHER_A,
      studentId: student.id,
      limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(5);
    expect(result.value.items).toHaveLength(2);
    expect(result.value.items[0].summary).toBe('记录4');
    expect(result.value.items[1].summary).toBe('记录3');
  });

  it('parent_communication 记录携带 communicationDetail，其他记录为 null', async () => {
    const student = await createStudent(TEACHER_A, '沟通学生');

    // 创建 parent_communication 记录 + detail
    const commRecord = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-02-10T00:00:00Z'),
      summary: '家长电话沟通作业问题',
      category: 'parent_communication',
      reviewStatus: 'confirmed',
    });
    await prisma.communicationDetail.create({
      data: {
        teacherId: TEACHER_A,
        studentRecordId: commRecord.id,
        direction: 'inbound',
        channel: 'phone',
        parentType: 'normal',
        parentConcerns: ['作业拖拉', '注意力不集中'],
        teacherResponses: ['已制定时间管理计划'],
        agreements: ['每周复盘'],
        followUps: ['下周检查习惯养成情况'],
        nextContactAtTs: new Date('2026-02-17T10:00:00Z'),
        moderationFlagged: true,
        moderationReasons: ['violence（暴力/威胁言论）'],
      },
    });

    // 一条普通记录（非 parent_communication）
    const noteRecord = await createRecord({
      teacherId: TEACHER_A,
      studentId: student.id,
      occurredAtTs: new Date('2026-02-11T00:00:00Z'),
      summary: '课堂表现专注',
      category: 'lesson_observation',
      reviewStatus: 'confirmed',
    });

    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const items = result.value.items;
    const commEntry = items.find((item) => item.id === commRecord.id)!;
    const noteEntry = items.find((item) => item.id === noteRecord.id)!;

    // parent_communication 记录有 detail
    expect(commEntry.communicationDetail).not.toBeNull();
    expect(commEntry.communicationDetail!.direction).toBe('inbound');
    expect(commEntry.communicationDetail!.channel).toBe('phone');
    expect(commEntry.communicationDetail!.parentType).toBe('normal');
    expect(commEntry.communicationDetail!.parentConcerns).toEqual(['作业拖拉', '注意力不集中']);
    expect(commEntry.communicationDetail!.followUps).toEqual(['下周检查习惯养成情况']);
    expect(commEntry.communicationDetail!.nextContactAtTs).toBe('2026-02-17T10:00:00.000Z');
    expect(commEntry.communicationDetail!.moderationFlagged).toBe(true);
    expect(commEntry.communicationDetail!.moderationReasons).toEqual(['violence（暴力/威胁言论）']);

    // 普通记录为 null
    expect(noteEntry.communicationDetail).toBeNull();
  });

  it('limit 非法返回 VALIDATION_ERROR', async () => {
    const student = await createStudent(TEACHER_A, '校验学生');

    const tooSmall = await service.getStudentTimeline({
      teacherId: TEACHER_A,
      studentId: student.id,
      limit: 0,
    });
    expect(tooSmall.ok).toBe(false);
    if (tooSmall.ok) return;
    expect(tooSmall.error.code).toBe('VALIDATION_ERROR');
    expect(tooSmall.error.field).toBe('limit');

    const tooLarge = await service.getStudentTimeline({
      teacherId: TEACHER_A,
      studentId: student.id,
      limit: 201,
    });
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) return;
    expect(tooLarge.error.code).toBe('VALIDATION_ERROR');
    expect(tooLarge.error.field).toBe('limit');
  });
});
