import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createStudentRecordsService } from '../../../src/features/student-records/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createStudentTimelineRouter } from '../../../src/app/routes/student-timeline.routes.js';

const TEACHER_ID = 'timeline-route-teacher';
const OTHER_TEACHER_ID = 'timeline-route-other';
const prisma = new PrismaClient();
const records = createStudentRecordsService(prisma);
const timeline = createStudentTimelineService(prisma);
const router = createStudentTimelineRouter(timeline);

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> };
}

async function createStudent(teacherId: string, name: string): Promise<string> {
  const student = await prisma.student.create({ data: { teacherId, name, grade: '高三' } });
  return student.id;
}

async function cleanup() {
  const teacherIds = { in: [TEACHER_ID, OTHER_TEACHER_ID] };
  await prisma.studentRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.changeLog.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.student.deleteMany({ where: { teacherId: teacherIds } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

async function invoke(options: { path: string; params: Record<string, string>; query?: Record<string, unknown>; teacherId: string }) {
  const layer = (router.stack as RouteLayer[]).find((candidate) => candidate.route?.path === options.path && candidate.route.methods.get);
  if (!layer?.route) throw new Error(`route not registered: GET ${options.path}`);
  let statusCode = 200;
  let responseBody: unknown;
  const req = { params: options.params, query: options.query ?? {}, teacherId: options.teacherId } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { responseBody = value; return this; },
  } as Response;
  await layer.route.stack[0].handle(req, res);
  return { statusCode, responseBody };
}

describe('student timeline routes', () => {
  it('在服务端解析组合筛选与分页，并拒绝倒置及非法日历边界', async () => {
    const studentId = await createStudent(TEACHER_ID, '筛选学生');
    await records.createRecord({ teacherId: TEACHER_ID, studentId, category: 'goal', summary: '目标记录', occurredAt: new Date('2026-01-01T00:00:00Z') });
    const filtered = await invoke({
      path: '/students/:studentId/timeline', params: { studentId },
      query: { page: '1', pageSize: '1', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', types: ['record'], categories: 'goal' }, teacherId: TEACHER_ID,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.responseBody).toMatchObject({ ok: true, data: { total: 1, page: 1, pageSize: 1, hasMore: false } });
    const invalid = await invoke({ path: '/students/:studentId/timeline', params: { studentId }, query: { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }, teacherId: TEACHER_ID });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.responseBody).toMatchObject({ ok: false, error: { field: 'from' } });
    const invalidCalendar = await invoke({ path: '/students/:studentId/timeline', params: { studentId }, query: { from: '2026-02-30T00:00:00+08:00' }, teacherId: TEACHER_ID });
    expect(invalidCalendar.statusCode).toBe(400);
    expect(invalidCalendar.responseBody).toMatchObject({ ok: false, error: { field: 'from' } });
  });

  it('detail 按类型和租户返回安全的正式记录', async () => {
    const studentId = await createStudent(TEACHER_ID, '详情学生');
    const created = await records.createRecord({ teacherId: TEACHER_ID, studentId, category: 'general_note', summary: '详情正文' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const detail = await invoke({ path: '/students/:studentId/timeline/:entryType/:entryId/detail', params: { studentId, entryType: 'record', entryId: created.value.id }, teacherId: TEACHER_ID });
    expect(detail.statusCode).toBe(200);
    expect(detail.responseBody).toMatchObject({ ok: true, data: { type: 'record', record: { id: created.value.id, studentId, summary: '详情正文' } } });
    const crossTenant = await invoke({ path: '/students/:studentId/timeline/:entryType/:entryId/detail', params: { studentId, entryType: 'record', entryId: created.value.id }, teacherId: OTHER_TEACHER_ID });
    expect(crossTenant.statusCode).toBe(404);
  });
});
