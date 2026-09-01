import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudentRecordsService,
  createStudentSourceRecordService,
} from '../../../src/features/student-records/index.js';
import { createAssessmentService } from '../../../src/features/assessments/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createAiClient } from '../../../src/shared/ai-client/index.js';
import type { AiProvider } from '../../../src/shared/ai-client/types.js';
import { createCaptureScoreFromTextUseCase } from '../../../src/app/use-cases/capture-score-from-text/index.js';
import type { StudentRecordsRouteDependencies } from '../../../src/app/composition/types.js';
import { createStudentRecordsRouter } from '../../../src/app/routes/student-records.routes.js';

const TEACHER_ID = 'capture-test-teacher';
const OTHER_TEACHER_ID = 'capture-test-other-teacher';

const ROUTE_PATH = '/students/:studentId/assessments/capture-from-text';

const prisma = new PrismaClient();

function createMockProvider(): AiProvider & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(),
  };
}

function buildDeps(mockProvider: AiProvider): StudentRecordsRouteDependencies {
  const records = createStudentRecordsService(prisma);
  const sources = createStudentSourceRecordService(prisma);
  const assessments = createAssessmentService(prisma);
  const timeline = createStudentTimelineService(prisma);
  const aiClient = createAiClient({ provider: mockProvider });
  const captureScoreFromText = createCaptureScoreFromTextUseCase({ prisma, aiClient, assessments });
  return { records, sources, assessments, timeline, captureScoreFromText };
}

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
  dependencies: StudentRecordsRouteDependencies;
  params?: Record<string, string>;
  body?: unknown;
  teacherId?: string;
}) {
  const router = createStudentRecordsRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find(
    (candidate) => candidate.route?.path === ROUTE_PATH && candidate.route.methods.post,
  );
  if (!layer?.route) throw new Error(`route not registered: POST ${ROUTE_PATH}`);

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    params: options.params ?? {},
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

describe('POST /students/:studentId/assessments/capture-from-text', () => {
  it('成功：rawText 带成绩 → 201，body 有 record/detail/sourceRecord，previousScore 持久化', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    mockProvider.run.mockResolvedValue({
      examName: '期中考试',
      subject: '数学',
      score: 92,
      fullScore: 100,
      examDate: '2024-04-15',
      previousScore: 85,
      note: '进步明显',
      confidence: 'high',
    });
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '张三 数学 期中考试 92 分，上次 85 分' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as {
      ok: boolean;
      data?: {
        record: { id: string; category: string; summary: string };
        detail: {
          score: number | null;
          fullScore: number | null;
          previousScore: number | null;
          subject: string | null;
          examName: string | null;
        };
        sourceRecord: { id: string } | null;
        extraction: { score: number | null };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.record.category).toBe('assessment');
    expect(body.data!.detail.score).toBe(92);
    expect(body.data!.detail.fullScore).toBe(100);
    expect(body.data!.detail.previousScore).toBe(85);
    expect(body.data!.detail.subject).toBe('数学');
    expect(body.data!.detail.examName).toBe('期中考试');
    expect(body.data!.extraction.score).toBe(92);
    expect(body.data!.sourceRecord).toEqual({ id: expect.any(String) });

    // 验证写入数据库
    const stored = await prisma.assessmentDetail.findUnique({
      where: { studentRecordId: body.data!.record.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.score).toBe(92);
    expect(stored!.previousScore).toBe(85);
  });

  it('rawText 为空 → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '   ' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('rawText 缺失 → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: {},
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('aiClient.run 返回 err → 透传 500 错误', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    mockProvider.run.mockRejectedValue(new Error('AI 服务不可用'));
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '一些成绩文字' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(500);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('跨 teacher（别的 teacher 的 studentId）→ NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '成绩 90 分' },
      teacherId: OTHER_TEACHER_ID,
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('occurredAt 非法 → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '成绩 90 分', occurredAt: 'not-a-date' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('occurredAt 合法 RFC3339 正常透传给 use case', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    mockProvider.run.mockResolvedValue({
      examName: '单元测试',
      subject: '英语',
      score: 88,
    });
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: {
        rawText: '英语单元测试 88 分',
        occurredAt: '2024-06-01T14:00:00+08:00',
      },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as { ok: boolean; data?: { record: { id: string } } };
    expect(body.ok).toBe(true);

    const stored = await prisma.studentRecord.findUnique({
      where: { id: body.data!.record.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.occurredAtTs.getTime()).toBe(
      Date.parse('2024-06-01T14:00:00+08:00'),
    );
  });

  it('缺少 x-teacher-id 返回 400 且不调用 use case', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: { rawText: '成绩 90 分' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('请求体非对象 → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      params: { studentId },
      body: 'just a string',
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });
});
