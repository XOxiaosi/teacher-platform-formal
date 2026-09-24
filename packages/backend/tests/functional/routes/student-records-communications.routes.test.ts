import type { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudentRecordsService,
  createStudentSourceRecordService,
} from '../../../src/features/student-records/index.js';
import { createAssessmentService } from '../../../src/features/assessments/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createCommunicationService } from '../../../src/features/student-communications/index.js';
import { createAiClient } from '../../../src/shared/ai-client/index.js';
import type { AiProvider } from '../../../src/shared/ai-client/types.js';
import { createCaptureScoreFromTextUseCase } from '../../../src/app/use-cases/capture-score-from-text/index.js';
import { createCaptureCommunicationFromTextUseCase } from '../../../src/app/use-cases/capture-communication-from-text/index.js';
import type { StudentRecordsRouteDependencies } from '../../../src/app/composition/types.js';
import { createStudentRecordsRouter } from '../../../src/app/routes/student-records.routes.js';

const TEACHER_ID = 'comm-test-teacher';
const OTHER_TEACHER_ID = 'comm-test-other-teacher';

const CAPTURE_ROUTE = '/students/:studentId/communications/capture-from-text';
const PATCH_ROUTE = '/students/:studentId/communications/:recordId';

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
  const communications = createCommunicationService(prisma);
  const captureCommunicationFromText = createCaptureCommunicationFromTextUseCase({
    prisma,
    aiClient,
    communications,
  });
  return {
    records,
    sources,
    assessments,
    timeline,
    captureScoreFromText,
    communications,
    captureCommunicationFromText,
  };
}

async function createStudent(teacherId: string, name: string): Promise<string> {
  const student = await prisma.student.create({
    data: { teacherId, name, grade: '高三' },
  });
  return student.id;
}

async function cleanup() {
  const teacherIds = { in: [TEACHER_ID, OTHER_TEACHER_ID] };
  await prisma.communicationDetail.deleteMany({ where: { teacherId: teacherIds } });
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
  routePath: string;
  method: 'post' | 'patch';
  params?: Record<string, string>;
  body?: unknown;
  teacherId?: string;
}) {
  const router = createStudentRecordsRouter(options.dependencies, {
    legacyModelCaptureRoutesEnabled: true,
  });
  const layer = (router.stack as RouteLayer[]).find(
    (candidate) => candidate.route?.path === options.routePath && candidate.route.methods[options.method],
  );
  if (!layer?.route) throw new Error(`route not registered: ${options.method.toUpperCase()} ${options.routePath}`);

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

// 创建一条 parent_communication 记录（直接走 service，避免依赖 capture）
async function createCommunicationRecord(teacherId: string, studentId: string) {
  const comms = createCommunicationService(prisma);
  const result = await comms.createCommunicationRecord({
    teacherId,
    studentId,
    summary: '家长电话沟通',
    direction: 'inbound',
    channel: 'phone',
    parentType: 'normal',
    parentConcerns: ['作业拖拉'],
    teacherResponses: ['已制定计划'],
    agreements: ['每周复盘'],
    followUps: ['下周检查作业习惯'],
  });
  if (!result.ok) throw new Error('createCommunicationRecord failed');
  return result.value;
}

describe('POST /students/:studentId/communications/capture-from-text', () => {
  it('默认不注册会绕过 DSH 确认链的旧模型写入路由', () => {
    const router = createStudentRecordsRouter(buildDeps(createMockProvider()));
    const layer = (router.stack as RouteLayer[]).find(
      (candidate) => candidate.route?.path === CAPTURE_ROUTE && candidate.route.methods.post,
    );
    expect(layer).toBeUndefined();
  });

  it('成功：rawText → 201，body 含 record/detail/sourceRecord', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    mockProvider.run.mockResolvedValue({
      direction: 'inbound',
      channel: 'wechat',
      parentType: 'normal',
      parentConcerns: ['孩子最近作业完成质量下降', '考试粗心'],
      teacherResponses: ['已做针对性练习计划'],
      agreements: ['每周检查一次作业'],
      followUps: ['下周跟进作业完成情况'],
      summary: '家长微信沟通孩子作业问题',
      confidence: 'high',
    });
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: CAPTURE_ROUTE,
      method: 'post',
      params: { studentId },
      body: { rawText: '家长微信说孩子最近作业质量下降，考试粗心' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(201);
    const body = responseBody as {
      ok: boolean;
      data?: {
        record: { id: string; category: string; summary: string };
        detail: {
          direction: string;
          channel: string | null;
          parentConcerns: string[];
          followUps: string[];
        };
        sourceRecord: { id: string } | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data!.record.category).toBe('parent_communication');
    expect(body.data!.detail.direction).toBe('inbound');
    expect(body.data!.detail.channel).toBe('wechat');
    expect(body.data!.detail.parentConcerns).toContain('孩子最近作业完成质量下降');
    expect(body.data!.detail.followUps).toContain('下周跟进作业完成情况');
    expect(body.data!.sourceRecord).toEqual({ id: expect.any(String) });

    // 验证写入数据库
    const stored = await prisma.communicationDetail.findUnique({
      where: { studentRecordId: body.data!.record.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.direction).toBe('inbound');
  });

  it('rawText 为空 → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: CAPTURE_ROUTE,
      method: 'post',
      params: { studentId },
      body: { rawText: '   ' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });

  it('跨 teacher → NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: CAPTURE_ROUTE,
      method: 'post',
      params: { studentId },
      body: { rawText: '一些沟通文字' },
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
      routePath: CAPTURE_ROUTE,
      method: 'post',
      params: { studentId },
      body: { rawText: '沟通文字', occurredAt: 'not-a-date' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(mockProvider.run).not.toHaveBeenCalled();
  });
});

describe('PATCH /students/:studentId/communications/:recordId', () => {
  it('成功：更新 direction/数组/nextContactAt', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { record, detail } = await createCommunicationRecord(TEACHER_ID, studentId);
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: PATCH_ROUTE,
      method: 'patch',
      params: { studentId, recordId: record.id },
      body: {
        direction: 'outbound',
        parentConcerns: ['新诉求1', '新诉求2'],
        followUps: ['新待办1'],
        nextContactAt: '2025-07-01T10:00:00Z',
      },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(200);
    const body = responseBody as { ok: boolean; data?: { direction: string; parentConcerns: string[]; followUps: string[]; nextContactAtTs: string | null } };
    expect(body.ok).toBe(true);
    expect(body.data!.direction).toBe('outbound');
    expect(body.data!.parentConcerns).toEqual(['新诉求1', '新诉求2']);
    expect(body.data!.followUps).toEqual(['新待办1']);
    expect(new Date(body.data!.nextContactAtTs as any).toISOString()).toBe('2025-07-01T10:00:00.000Z');

    // 验证持久化
    const stored = await prisma.communicationDetail.findUnique({ where: { id: detail.id } });
    expect(stored!.direction).toBe('outbound');
  });

  it('非法 direction → 400 VALIDATION_ERROR', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { record } = await createCommunicationRecord(TEACHER_ID, studentId);
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: PATCH_ROUTE,
      method: 'patch',
      params: { studentId, recordId: record.id },
      body: { direction: 'invalid-direction' },
      teacherId: TEACHER_ID,
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('跨 teacher → 404 NOT_FOUND', async () => {
    const studentId = await createStudent(TEACHER_ID, '张三');
    const { record } = await createCommunicationRecord(TEACHER_ID, studentId);
    const mockProvider = createMockProvider();
    const deps = buildDeps(mockProvider);

    const { statusCode, responseBody } = await invoke({
      dependencies: deps,
      routePath: PATCH_ROUTE,
      method: 'patch',
      params: { studentId, recordId: record.id },
      body: { direction: 'outbound' },
      teacherId: OTHER_TEACHER_ID,
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
