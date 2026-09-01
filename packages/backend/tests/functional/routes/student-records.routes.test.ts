import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createStudentRecordsService,
  createStudentSourceRecordService,
} from '../../../src/features/student-records/index.js';
import { createAssessmentService } from '../../../src/features/assessments/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createStudentRecordsRouter } from '../../../src/app/routes/student-records.routes.js';

const TEACHER_ID = 'route-test-teacher';
const OTHER_TEACHER_ID = 'route-test-other-teacher';

const prisma = new PrismaClient();
const dependencies = {
  records: createStudentRecordsService(prisma),
  sources: createStudentSourceRecordService(prisma),
  assessments: createAssessmentService(prisma),
  timeline: createStudentTimelineService(prisma),
};
const router = createStudentRecordsRouter(dependencies);

async function createStudent(teacherId: string, name: string): Promise<string> {
  const student = await prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
  return student.id;
}

async function cleanup() {
  const teacherIds = { in: [TEACHER_ID, OTHER_TEACHER_ID] };
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.changeLog.deleteMany({ where: { teacherId: teacherIds } });
  await prisma.student.deleteMany({ where: { teacherId: teacherIds } });
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

async function invoke(options: {
  method: 'get' | 'post';
  path: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  teacherId?: string;
}) {
  const layer = (router.stack as RouteLayer[]).find(
    (candidate) =>
      candidate.route?.path === options.path && candidate.route.methods[options.method],
  );
  if (!layer?.route) {
    throw new Error(`route not registered: ${options.method.toUpperCase()} ${options.path}`);
  }

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body,
    // P0 IDOR 修复：身份来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）
    teacherId: options.teacherId,
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      responseBody = value;
      return this;
    },
  } as Response;

  await layer.route.stack[0].handle(req, res);
  return { statusCode, responseBody };
}

describe('student-records routes', () => {
  it('GET /students/sources/unresolved 注册在 /students/:studentId/* 之前', () => {
    const paths = (router.stack as RouteLayer[])
      .filter((layer) => layer.route)
      .map((layer) => layer.route!.path);
    const unresolved = paths.indexOf('/students/sources/unresolved');
    const timeline = paths.indexOf('/students/:studentId/timeline');
    const records = paths.indexOf('/students/:studentId/records');
    expect(unresolved).toBeGreaterThanOrEqual(0);
    expect(timeline).toBeGreaterThanOrEqual(0);
    expect(records).toBeGreaterThanOrEqual(0);
    expect(unresolved).toBeLessThan(timeline);
    expect(unresolved).toBeLessThan(records);
  });

  it('GET /students/:studentId/timeline 返回时间线条目', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await dependencies.records.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '时间线记录',
    });
    expect(created.ok).toBe(true);

    const { statusCode, responseBody } = await invoke({
      method: 'get',
      path: '/students/:studentId/timeline',
      params: { studentId },
      query: { limit: 10 },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(200);
    const body = responseBody as {
      ok: boolean;
      data?: { items: Array<{ type: string; summary: string | null }>; total: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.total).toBe(1);
    expect(body.data!.items[0].summary).toBe('时间线记录');
    expect(body.data!.items[0].type).toBe('record');
  });

  it('GET /students/:studentId/records 按 occurredAt 倒序分页', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const summaries = [
      { summary: '记录1', occurredAt: new Date('2024-01-01T00:00:00Z') },
      { summary: '记录2', occurredAt: new Date('2024-02-01T00:00:00Z') },
      { summary: '记录3', occurredAt: new Date('2024-03-01T00:00:00Z') },
    ];
    for (const item of summaries) {
      await dependencies.records.createRecord({
        teacherId: TEACHER_ID,
        studentId,
        category: 'general_note',
        summary: item.summary,
        occurredAt: item.occurredAt,
      });
    }

    const page1 = await invoke({
      method: 'get',
      path: '/students/:studentId/records',
      params: { studentId },
      query: { page: 1, pageSize: 2 },
      teacherId: TEACHER_ID,
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.responseBody as {
      ok: boolean;
      data?: { items: Array<{ summary: string }>; total: number };
    };
    expect(body1.ok).toBe(true);
    expect(body1.data!.total).toBe(3);
    expect(body1.data!.items.map((item) => item.summary)).toEqual(['记录3', '记录2']);

    const page2 = await invoke({
      method: 'get',
      path: '/students/:studentId/records',
      params: { studentId },
      query: { page: 2, pageSize: 2 },
      teacherId: TEACHER_ID,
    });
    const body2 = page2.responseBody as {
      ok: boolean;
      data?: { items: Array<{ summary: string }>; total: number };
    };
    expect(body2.ok).toBe(true);
    expect(body2.data!.items.map((item) => item.summary)).toEqual(['记录1']);
  });

  it('POST /students/:studentId/records 创建记录并解析 RFC3339 occurredAt', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/records',
      params: { studentId },
      body: {
        category: 'general_note',
        summary: '带时间的记录',
        occurredAt: '2024-05-01T10:30:00+08:00',
        structuredData: { score: 92 },
        confidence: 'high',
        visibility: 'internal_only',
        importance: 'important',
      },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as {
      ok: boolean;
      data?: {
        id: string;
        summary: string;
        occurredAt: Date;
        reviewStatus: string;
        structuredData: Record<string, unknown> | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.summary).toBe('带时间的记录');
    expect(body.data!.reviewStatus).toBe('candidate');
    expect(body.data!.occurredAt.getTime()).toBe(Date.parse('2024-05-01T10:30:00+08:00'));
    expect(body.data!.structuredData).toEqual({ score: 92 });

    const stored = await prisma.studentRecord.findUnique({ where: { id: body.data!.id } });
    expect(stored).not.toBeNull();
    expect(stored!.occurredAtTs.getTime()).toBe(Date.parse('2024-05-01T10:30:00+08:00'));
  });

  it('POST /students/:studentId/records 拒绝通用入口创建 parent_communication', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/records',
      params: { studentId },
      body: { category: 'parent_communication', summary: '家长沟通摘要' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'category' },
    });
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('POST /students/:studentId/records 非法 occurredAt 返回 400', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/records',
      params: { studentId },
      body: { category: 'general_note', summary: '非法日期', occurredAt: 'not-a-date' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('POST /students/:studentId/assessments 创建成绩记录', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/assessments',
      params: { studentId },
      body: {
        examName: '期中考试',
        subject: '数学',
        score: 92,
        fullScore: 100,
        examDate: '2024-05-01T00:00:00Z',
        note: '进步明显',
      },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as {
      ok: boolean;
      data?: {
        record: { id: string; category: string; summary: string };
        detail: { score: number; fullScore: number; subject: string | null; examDate: Date };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.record.category).toBe('assessment');
    expect(body.data!.record.summary).toBe('数学 期中考试 92分');
    expect(body.data!.detail.score).toBe(92);
    expect(body.data!.detail.fullScore).toBe(100);
    expect(body.data!.detail.subject).toBe('数学');
    expect(body.data!.detail.examDate.getTime()).toBe(Date.parse('2024-05-01T00:00:00Z'));
  });

  it('POST /students/:studentId/assessments/correct 纠正后旧记录 superseded', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const created = await dependencies.assessments.createScoreRecord({
      teacherId: TEACHER_ID,
      studentId,
      examName: '期中考试',
      subject: '数学',
      score: 92,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldRecordId = created.value.record.id;

    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/assessments/correct',
      params: { studentId },
      body: { oldRecordId, score: 95 },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as {
      ok: boolean;
      data?: {
        record: { id: string; supersedesId: string | null; summary: string };
        detail: { score: number };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.record.id).not.toBe(oldRecordId);
    expect(body.data!.record.supersedesId).toBe(oldRecordId);
    expect(body.data!.detail.score).toBe(95);

    const oldRecord = await prisma.studentRecord.findUnique({ where: { id: oldRecordId } });
    expect(oldRecord).not.toBeNull();
    expect(oldRecord!.reviewStatus).toBe('superseded');
  });

  it('POST /students/:studentId/records/:recordId/review 确认/拒绝 + 跨 teacher 隔离', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');

    const recordA = await dependencies.records.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待确认',
    });
    expect(recordA.ok).toBe(true);
    if (!recordA.ok) return;

    const confirmed = await invoke({
      method: 'post',
      path: '/students/:studentId/records/:recordId/review',
      params: { studentId, recordId: recordA.value.id },
      body: { reviewStatus: 'confirmed' },
      teacherId: TEACHER_ID,
    });
    expect(confirmed.statusCode).toBe(201);
    const confirmedBody = confirmed.responseBody as { ok: boolean; data?: { reviewStatus: string } };
    expect(confirmedBody.ok).toBe(true);
    expect(confirmedBody.data!.reviewStatus).toBe('confirmed');

    const crossTeacher = await invoke({
      method: 'post',
      path: '/students/:studentId/records/:recordId/review',
      params: { studentId, recordId: recordA.value.id },
      body: { reviewStatus: 'confirmed' },
      teacherId: OTHER_TEACHER_ID,
    });
    expect(crossTeacher.statusCode).toBe(404);
    expect(crossTeacher.responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const otherStudentId = await createStudent(TEACHER_ID, '李四');
    const mismatchedStudent = await invoke({
      method: 'post',
      path: '/students/:studentId/records/:recordId/review',
      params: { studentId: otherStudentId, recordId: recordA.value.id },
      body: { reviewStatus: 'confirmed' },
      teacherId: TEACHER_ID,
    });
    expect(mismatchedStudent.statusCode).toBe(404);
    expect(mismatchedStudent.responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const recordB = await dependencies.records.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待拒绝',
    });
    expect(recordB.ok).toBe(true);
    if (!recordB.ok) return;

    const rejected = await invoke({
      method: 'post',
      path: '/students/:studentId/records/:recordId/review',
      params: { studentId, recordId: recordB.value.id },
      body: { reviewStatus: 'rejected' },
      teacherId: TEACHER_ID,
    });
    expect(rejected.statusCode).toBe(201);
    const rejectedBody = rejected.responseBody as { ok: boolean; data?: { reviewStatus: string } };
    expect(rejectedBody.ok).toBe(true);
    expect(rejectedBody.data!.reviewStatus).toBe('rejected');
  });

  it('POST review 非法 reviewStatus 返回 400', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const record = await dependencies.records.createRecord({
      teacherId: TEACHER_ID,
      studentId,
      category: 'general_note',
      summary: '待审核',
    });
    if (!record.ok) return;

    const { statusCode, responseBody } = await invoke({
      method: 'post',
      path: '/students/:studentId/records/:recordId/review',
      params: { studentId, recordId: record.value.id },
      body: { reviewStatus: 'bogus' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('GET /students/sources/unresolved 不被 :studentId 吞掉', async () => {
    await prisma.studentSourceRecord.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: null,
        sourceType: 'agent_text',
        sourceEntityType: null,
        sourceEntityId: null,
        occurredAtTs: new Date(),
        rawText: '未解析文本',
        captureStatus: 'unresolved',
      },
    });

    const { statusCode, responseBody } = await invoke({
      method: 'get',
      path: '/students/sources/unresolved',
      query: { page: 1, pageSize: 20 },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(200);
    const body = responseBody as {
      ok: boolean;
      data?: { items: Array<{ captureStatus: string; rawText: string | null }>; total: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.total).toBe(1);
    expect(body.data!.items[0].captureStatus).toBe('unresolved');
    expect(body.data!.items[0].rawText).toBe('未解析文本');
  });
});
