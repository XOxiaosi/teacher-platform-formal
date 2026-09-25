import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';

const prisma = new PrismaClient();
const service = createStudentTimelineService(prisma);
const TEACHER_A = 'test-teacher-timeline-filter-a';
const TEACHER_B = 'test-teacher-timeline-filter-b';

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
  return prisma.student.create({ data: { teacherId, name, grade: '高三' } });
}

function createRecord(input: { teacherId: string; studentId: string; occurredAtTs: Date; summary: string; category?: string; reviewStatus?: string }) {
  return prisma.studentRecord.create({ data: {
    teacherId: input.teacherId, studentId: input.studentId, category: input.category ?? 'general_note',
    occurredAtTs: input.occurredAtTs, summary: input.summary, reviewStatus: input.reviewStatus ?? 'candidate', visibility: 'needs_review',
  } });
}

async function createLesson(input: { teacherId: string; studentId: string; dateTs: Date; progress?: string; teacherNote?: string }) {
  const schedule = await prisma.schedule.create({ data: {
    teacherId: input.teacherId, studentId: input.studentId, type: 'lesson', title: '时间线课程',
    scheduledStartTs: input.dateTs, scheduledEndTs: new Date(input.dateTs.getTime() + 90 * 60 * 1000),
  } });
  return prisma.lesson.create({ data: {
    teacherId: input.teacherId, studentId: input.studentId, scheduleId: schedule.id, dateTs: input.dateTs,
    status: 'attended', progress: input.progress ?? null, teacherNote: input.teacherNote ?? null,
  } });
}

function createFeedback(input: { teacherId: string; studentId: string; title: string; content: string; status?: string; sentAtTs?: Date | null }) {
  return prisma.parentFeedback.create({ data: {
    teacherId: input.teacherId, studentId: input.studentId, title: input.title, content: input.content,
    status: input.status ?? 'draft', sentAtTs: input.sentAtTs ?? null,
  } });
}

beforeEach(cleanup);
afterEach(cleanup);

describe('studentTimelineService filtering and detail contracts', () => {
  it('先在完整集合上应用时间与类别筛选，再分页并返回过滤后的 total', async () => {
    const student = await createStudent(TEACHER_A, '长期筛选学生');
    for (let i = 0; i < 205; i += 1) await createRecord({
      teacherId: TEACHER_A, studentId: student.id, occurredAtTs: new Date(Date.UTC(2026, 0, 1 + i)),
      summary: `历史记录${i}`, category: i === 0 ? 'goal' : 'general_note',
    });
    const result = await service.getStudentTimeline({
      teacherId: TEACHER_A, studentId: student.id, page: 1, pageSize: 2,
      from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-02T00:00:00Z'),
      types: ['record'], categories: ['goal'],
    });
    expect(result).toMatchObject({ ok: true, value: { total: 1, page: 1, pageSize: 2, hasMore: false } });
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].summary).toBe('历史记录0');
  });

  it('第 201 条历史记录仍可被服务端筛选，且分页稳定', async () => {
    const student = await createStudent(TEACHER_A, '第201条学生');
    for (let i = 0; i < 205; i += 1) await createRecord({
      teacherId: TEACHER_A, studentId: student.id, occurredAtTs: new Date(Date.UTC(2026, 0, 1 + i)),
      summary: i === 0 ? '最旧目标（最近200条之外）' : `其他${i}`, category: i === 0 ? 'goal' : 'general_note',
    });
    const recent = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id, page: 1, pageSize: 200 });
    expect(recent).toMatchObject({ ok: true, value: { total: 205 } });
    if (!recent.ok) return;
    expect(recent.value.items.some((item) => item.summary === '最旧目标（最近200条之外）')).toBe(false);
    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id, page: 1, pageSize: 1, types: ['record'], categories: ['goal'] });
    expect(result).toMatchObject({ ok: true, value: { total: 1, hasMore: false } });
    if (!result.ok) return;
    expect(result.value.items[0].summary).toBe('最旧目标（最近200条之外）');
  });

  it('同一时间的跨类型条目按类型后 ID 稳定排序', async () => {
    const student = await createStudent(TEACHER_A, '同时间排序学生');
    await createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '同时间反馈', content: '反馈', sentAtTs: new Date('2026-08-01T00:00:00Z') });
    await createLesson({ teacherId: TEACHER_A, studentId: student.id, dateTs: new Date('2026-08-01T00:00:00Z') });
    await createRecord({ teacherId: TEACHER_A, studentId: student.id, occurredAtTs: new Date('2026-08-01T00:00:00Z'), summary: '同时间记录' });
    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.type)).toEqual(['record', 'lesson', 'feedback']);
  });

  it('类型化 openTarget 携带真实记录与来源 ID', async () => {
    const student = await createStudent(TEACHER_A, '详情目标学生');
    const record = await createRecord({ teacherId: TEACHER_A, studentId: student.id, occurredAtTs: new Date('2026-06-01T00:00:00Z'), summary: '详情目标' });
    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[0].openTarget).toEqual({ type: 'record', recordId: record.id, sourceRecordId: null });
    const detail = await service.getStudentTimelineDetail({ teacherId: TEACHER_A, studentId: student.id, entryType: 'record', entryId: record.id });
    expect(detail).toMatchObject({ ok: true, value: { type: 'record', record: { id: record.id, studentId: student.id, summary: '详情目标' } } });
  });

  it('课程与家长反馈详情只返回当前学生的业务字段', async () => {
    const student = await createStudent(TEACHER_A, '课程反馈详情学生');
    const lesson = await createLesson({ teacherId: TEACHER_A, studentId: student.id, dateTs: new Date('2026-07-01T00:00:00Z'), progress: '函数复习', teacherNote: '注意错题' });
    const feedback = await createFeedback({ teacherId: TEACHER_A, studentId: student.id, title: '课后反馈', content: '已完成订正', status: 'reviewed' });
    await expect(service.getStudentTimelineDetail({ teacherId: TEACHER_A, studentId: student.id, entryType: 'lesson', entryId: lesson.id })).resolves.toMatchObject({ ok: true, value: { type: 'lesson', lesson: { studentId: student.id, progress: '函数复习' } } });
    await expect(service.getStudentTimelineDetail({ teacherId: TEACHER_A, studentId: student.id, entryType: 'feedback', entryId: feedback.id })).resolves.toMatchObject({ ok: true, value: { type: 'feedback', feedback: { studentId: student.id, title: '课后反馈', content: '已完成订正' } } });
  });

  it('旧 limit 与 pageSize 同传时仍以 limit 字段返回非法参数', async () => {
    const student = await createStudent(TEACHER_A, '校验学生');
    const result = await service.getStudentTimeline({ teacherId: TEACHER_A, studentId: student.id, limit: 0, pageSize: 10 });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'limit' } });
  });
});
