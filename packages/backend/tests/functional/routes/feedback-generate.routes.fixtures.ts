import type { Request, Response } from 'express';
import { vi } from 'vitest';
import type { FeedbackGenerateRouteDependencies } from '../../../src/app/composition/types.js';
import { createFeedbackRouter } from '../../../src/app/routes/feedback.routes.js';

export function createDependencies() {
  return {
    feedbackService: {
      createFeedback: vi.fn(),
      getFeedback: vi.fn(),
      listFeedbacks: vi.fn(),
      updateFeedbackContent: vi.fn(),
      updateFeedbackStatus: vi.fn(),
      getFeedbackSnapshot: vi.fn(),
    },
    feedbackDraftTasks: { create: vi.fn(), list: vi.fn(), get: vi.fn(), retry: vi.fn(), updateDraft: vi.fn() },
  } as unknown as FeedbackGenerateRouteDependencies;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

export function invokePostFeedback(options: {
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

export function invokeGetFeedback(options: {
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

export function invokeGetSnapshot(options: {
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
