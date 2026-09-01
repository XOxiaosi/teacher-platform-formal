import type { Request, Response } from 'express';
import { ok, err, notFound } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackGenerateRouteDependencies } from '../../../src/app/composition/types.js';
import { createFeedbackRouter } from '../../../src/app/routes/feedback.routes.js';

const ROUTE_PATH = '/feedback/generate-draft';

function createDependencies() {
  return {
    generateFeedbackDraft: { execute: vi.fn() },
    feedbackService: {
      createFeedback: vi.fn(),
      getFeedback: vi.fn(),
      listFeedbacks: vi.fn(),
      updateFeedbackContent: vi.fn(),
      updateFeedbackStatus: vi.fn(),
      getFeedbackSnapshot: vi.fn(),
    },
  } as unknown as FeedbackGenerateRouteDependencies;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

async function invokeRoute(options: {
  dependencies: FeedbackGenerateRouteDependencies;
  body: unknown;
  teacherId?: string;
}) {
  const router = createFeedbackRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === ROUTE_PATH && candidate.route.methods.post
  ));
  if (!layer?.route) throw new Error(`route not registered: POST ${ROUTE_PATH}`);

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
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

describe('POST /feedback/generate-draft', () => {
  it('成功：带 x-teacher-id + {studentId, tone} 返回 201 与完整 data 形状', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: ['lesson-1', 'lesson-2'],
      title: '本周学习反馈',
      content: '本周课堂表现良好。',
      rationale: '用课堂表现给家长确定感。',
      source: 'ai',
      evidence: [],
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', tone: 'warm' },
    });

    expect(statusCode).toBe(201);
    expect(responseBody).toEqual({ ok: true, data: draft });
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'student-1',
      lessonIds: undefined,
      tone: 'warm',
      classSize: undefined,
      parentType: undefined,
      focus: undefined,
    });
  });

  it('缺少 x-teacher-id 返回 400 且不派发用例', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      body: { studentId: 'student-1' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('缺少 studentId 返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { tone: 'warm' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('studentId 非字符串返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 123 },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('lessonIds 含非字符串返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', lessonIds: ['lesson-1', 42] },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('tone 非白名单返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', tone: 'angry' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('use-case 返回 notFound（学生不存在）时透传 404', async () => {
    const dependencies = createDependencies();
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => err(notFound('学生不存在')));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'missing-student' },
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'missing-student',
      lessonIds: undefined,
      tone: undefined,
      classSize: undefined,
      parentType: undefined,
      focus: undefined,
    });
  });

  // ===== 新增：可选字段校验与透传 =====

  it('classSize 合法值（1v1/small/large）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: [],
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      classSize: '1v1' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', classSize: '1v1' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ classSize: '1v1' }),
    );
  });

  it('classSize 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', classSize: 'huge' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'classSize' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('parentType 合法值（normal/scores/sensitive）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: [],
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      parentType: 'scores' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', parentType: 'scores' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ parentType: 'scores' }),
    );
  });

  it('parentType 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', parentType: 'crazy' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'parentType' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('focus 合法值（highlight/problem/cooperation/summary）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: [],
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      focus: 'highlight' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', focus: 'highlight' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ focus: 'highlight' }),
    );
  });

  it('focus 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', focus: 'praise' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'focus' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('三个可选字段一起合法透传：classSize + parentType + focus', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: [],
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: {
        studentId: 'student-1',
        classSize: 'small',
        parentType: 'sensitive',
        focus: 'cooperation',
      },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'student-1',
      lessonIds: undefined,
      tone: undefined,
      classSize: 'small',
      parentType: 'sensitive',
      focus: 'cooperation',
    });
  });
});

// ===== D40 Phase 5: 反馈 CRUD + 快照 路由 =====

function invokePostFeedback(options: {
  dependencies: FeedbackGenerateRouteDependencies;
  body: unknown;
  teacherId?: string;
}) {
  const router = createFeedbackRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === '/feedback' && candidate.route.methods.post
  ));
  if (!layer?.route) throw new Error('route not registered: POST /feedback');

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
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

  layer.route.stack[0].handle(req, res);
  return Promise.resolve().then(() => ({ statusCode, responseBody }));
}

function invokeGetFeedback(options: {
  dependencies: FeedbackGenerateRouteDependencies;
  query: Record<string, unknown>;
  teacherId?: string;
}) {
  const router = createFeedbackRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === '/feedback' && candidate.route.methods.get
  ));
  if (!layer?.route) throw new Error('route not registered: GET /feedback');

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    query: options.query,
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

  layer.route.stack[0].handle(req, res);
  return Promise.resolve().then(() => ({ statusCode, responseBody }));
}

function invokeGetSnapshot(options: {
  dependencies: FeedbackGenerateRouteDependencies;
  feedbackId: string;
  teacherId?: string;
}) {
  const router = createFeedbackRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === '/feedback/:feedbackId/snapshot' && candidate.route.methods.get
  ));
  if (!layer?.route) throw new Error('route not registered: GET /feedback/:feedbackId/snapshot');

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    params: { feedbackId: options.feedbackId },
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

  layer.route.stack[0].handle(req, res);
  return Promise.resolve().then(() => ({ statusCode, responseBody }));
}

describe('POST /feedback', () => {
  it('成功：带 evidence 创建反馈返回 201', async () => {
    const deps = createDependencies();
    const mockFeedback = { id: 'fb-1', title: '测试', content: '内容' };
    (deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback.mockResolvedValue(ok(mockFeedback));

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: {
        studentId: 'student-1',
        title: '测试',
        content: '内容',
        evidence: [{ type: 'record', occurredAt: '2026-01-01T00:00:00Z' }],
        windowStart: '2026-01-01T00:00:00Z',
        windowEnd: '2026-02-01T00:00:00Z',
      },
    });

    expect(statusCode).toBe(201);
    expect(responseBody).toEqual({ ok: true, data: mockFeedback });
    expect((deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        studentId: 'student-1',
        title: '测试',
        content: '内容',
        evidence: [{ type: 'record', occurredAt: '2026-01-01T00:00:00Z' }],
        windowStart: '2026-01-01T00:00:00Z',
        windowEnd: '2026-02-01T00:00:00Z',
      }),
    );
  });

  it('缺 title 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', content: '内容' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'title' } });
  });

  it('evidence 非数组返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', title: '标题', content: '内容', evidence: 'not-array' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'evidence' } });
    expect((deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback).not.toHaveBeenCalled();
  });

  it('缺少 teacherId 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      body: { studentId: 'student-1', title: '标题', content: '内容' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('GET /feedback', () => {
  it('成功：列表返回 200', async () => {
    const deps = createDependencies();
    const mockResult = { items: [{ id: 'fb-1' }], total: 1 };
    (deps.feedbackService as { listFeedbacks: ReturnType<typeof vi.fn> }).listFeedbacks.mockResolvedValue(ok(mockResult));

    const { statusCode, responseBody } = await invokeGetFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      query: { studentId: 'student-1', status: 'draft', page: '1', pageSize: '10' },
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({ ok: true, data: mockResult });
    expect((deps.feedbackService as { listFeedbacks: ReturnType<typeof vi.fn> }).listFeedbacks).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        studentId: 'student-1',
        status: 'draft',
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it('非法 status 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokeGetFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      query: { status: 'invalid' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' } });
  });
});

describe('GET /feedback/:feedbackId/snapshot', () => {
  it('成功：快照返回 200', async () => {
    const deps = createDependencies();
    const mockSnapshot = {
      feedbackId: 'fb-1',
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:00:00.000Z',
      assembledAt: '2026-03-01T00:00:00.000Z',
      evidence: [],
    };
    (deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot.mockResolvedValue(ok(mockSnapshot));

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      teacherId: 'teacher-1',
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({ ok: true, data: mockSnapshot });
    expect((deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      feedbackId: 'fb-1',
    });
  });

  it('NOT_FOUND 跨 teacher 透传 404', async () => {
    const deps = createDependencies();
    (deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot.mockResolvedValue(
      err(notFound('该反馈没有依据快照')),
    );

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      teacherId: 'teacher-2',
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('缺少 teacherId 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});
