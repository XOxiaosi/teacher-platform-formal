import type { Request, Response } from 'express';
import { versionConflict } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { EditRouteDependencies } from '../../../src/app/composition/types.js';
import { createEditRouter } from '../../../src/app/routes/edit.routes.js';

const EXPECTED = '2026-08-16T10:00:00.000Z';

function createDependencies() {
  return {
    updateStudentProfile: { updateStudentProfile: vi.fn() },
    rescheduleLesson: { rescheduleLesson: vi.fn() },
    updateLessonRecord: { updateLessonRecord: vi.fn() },
    updatePayment: { updatePayment: vi.fn() },
    updateMemo: { updateMemo: vi.fn() },
    updateParentFeedbackContent: { updateParentFeedbackContent: vi.fn() },
  } as unknown as EditRouteDependencies;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

async function invokeRoute(options: {
  dependencies: EditRouteDependencies;
  method: string;
  routePath: string;
  params: Record<string, string>;
  body: unknown;
  teacherId?: string;
}) {
  const router = createEditRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === options.routePath && candidate.route.methods[options.method]
  ));
  if (!layer?.route) throw new Error(`route not registered: ${options.method} ${options.routePath}`);

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    body: options.body,
    params: options.params,
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
  return { status: statusCode, body: responseBody };
}

const cases = [
  {
    name: 'student profile', method: 'patch', routePath: '/students/:studentId/profile',
    params: { studentId: 'student-1' }, bodyKey: 'changes', payload: { name: '小明' },
    dependency: 'updateStudentProfile', operation: 'updateStudentProfile',
    idKey: 'studentId', id: 'student-1',
  },
  {
    name: 'schedule reschedule', method: 'post', routePath: '/schedules/:scheduleId/reschedule',
    params: { scheduleId: 'schedule-1' }, bodyKey: 'replacement',
    payload: { scheduledStart: '2026-08-17T01:00:00.000Z', scheduledEnd: '2026-08-17T02:00:00.000Z' },
    dependency: 'rescheduleLesson', operation: 'rescheduleLesson',
    idKey: 'scheduleId', id: 'schedule-1',
  },
  {
    name: 'lesson record', method: 'patch', routePath: '/lessons/:lessonId/record',
    params: { lessonId: 'lesson-1' }, bodyKey: 'changes', payload: { progress: '完成第一章' },
    dependency: 'updateLessonRecord', operation: 'updateLessonRecord', idKey: 'lessonId', id: 'lesson-1',
  },
  {
    name: 'payment', method: 'patch', routePath: '/payments/:paymentId',
    params: { paymentId: 'payment-1' }, bodyKey: 'changes', payload: { amount: 1200 },
    dependency: 'updatePayment', operation: 'updatePayment', idKey: 'paymentId', id: 'payment-1',
  },
  {
    name: 'memo', method: 'patch', routePath: '/memos/:memoId',
    params: { memoId: 'memo-1' }, bodyKey: 'changes', payload: { title: '新标题' },
    dependency: 'updateMemo', operation: 'updateMemo', idKey: 'memoId', id: 'memo-1',
  },
  {
    name: 'feedback content', method: 'patch', routePath: '/feedback/:feedbackId/content',
    params: { feedbackId: 'feedback-1' }, bodyKey: 'changes', payload: { content: '本周进步明显' },
    dependency: 'updateParentFeedbackContent', operation: 'updateParentFeedbackContent',
    idKey: 'feedbackId', id: 'feedback-1',
  },
] as const;

describe('createEditRouter', () => {
  it.each(cases)('registers and dispatches $name with trusted adapter fields', async (testCase) => {
    const dependencies = createDependencies();
    const operation = dependencies[testCase.dependency][testCase.operation] as ReturnType<typeof vi.fn>;
    const result = { value: { id: testCase.id, updatedAt: EXPECTED }, changeLogId: 'log-1' };
    operation.mockResolvedValue({ ok: true, value: result });

    const response = await invokeRoute({
      dependencies,
      method: testCase.method,
      routePath: testCase.routePath,
      params: testCase.params,
      teacherId: 'teacher-1',
      body: { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload },
    });

    expect(response).toEqual({ status: 200, body: { ok: true, data: result } });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      [testCase.idKey]: testCase.id,
      expectedUpdatedAt: EXPECTED,
      source: 'manual-web',
      [testCase.bodyKey]: testCase.payload,
    });
  });

  it.each(cases)('rejects a missing teacher header for $name before use-case dispatch', async (testCase) => {
    const dependencies = createDependencies();
    const operation = dependencies[testCase.dependency][testCase.operation] as ReturnType<typeof vi.fn>;
    const response = await invokeRoute({
      dependencies,
      method: testCase.method,
      routePath: testCase.routePath,
      params: testCase.params,
      body: { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(cases)('requires an exact plain top-level body for $name', async (testCase) => {
    const invalidBodies = [
      null,
      [],
      {},
      { expectedUpdatedAt: EXPECTED },
      { [testCase.bodyKey]: testCase.payload },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, unknown: true },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, teacherId: 'attacker' },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, source: 'system' },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, confirm: true },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, actionToken: 'token' },
      { expectedUpdatedAt: EXPECTED, [testCase.bodyKey]: testCase.payload, [testCase.idKey]: 'other' },
    ];

    for (const body of invalidBodies) {
      const dependencies = createDependencies();
      const operation = dependencies[testCase.dependency][testCase.operation] as ReturnType<typeof vi.fn>;
      const response = await invokeRoute({
        dependencies,
        method: testCase.method,
        routePath: testCase.routePath,
        params: testCase.params,
        teacherId: 'teacher-1',
        body,
      });

      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('converts a thrown use-case failure to the unified INTERNAL_ERROR JSON response', async () => {
    const dependencies = createDependencies();
    const operation = dependencies.updateMemo.updateMemo as ReturnType<typeof vi.fn>;
    operation.mockRejectedValue(new Error('database unavailable'));

    const response = await invokeRoute({
      dependencies,
      method: 'patch',
      routePath: '/memos/:memoId',
      params: { memoId: 'memo-1' },
      teacherId: 'teacher-1',
      body: { expectedUpdatedAt: EXPECTED, changes: { title: '新标题' } },
    });

    expect(response).toEqual({
      status: 500,
      body: { ok: false, error: { code: 'INTERNAL_ERROR', message: '编辑操作失败' } },
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('preserves VERSION_CONFLICT as HTTP 409 and dispatches only once', async () => {
    const dependencies = createDependencies();
    const operation = dependencies.updatePayment.updatePayment as ReturnType<typeof vi.fn>;
    operation.mockResolvedValue({ ok: false, error: versionConflict() });

    const response = await invokeRoute({
      dependencies,
      method: 'patch',
      routePath: '/payments/:paymentId',
      params: { paymentId: 'payment-1' },
      teacherId: 'teacher-1',
      body: { expectedUpdatedAt: EXPECTED, changes: { note: '冲突测试' } },
    });

    expect(response).toEqual({ status: 409, body: { ok: false, error: versionConflict() } });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
