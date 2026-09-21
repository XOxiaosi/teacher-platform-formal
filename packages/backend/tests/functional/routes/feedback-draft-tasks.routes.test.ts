import { ok } from '@teacher-platform/contracts';
import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackGenerateRouteDependencies } from '../../../src/app/composition/types.js';
import { createFeedbackRouter } from '../../../src/app/routes/feedback.routes.js';

function dependencies(): FeedbackGenerateRouteDependencies {
  return {
    generateFeedbackDraft: { execute: vi.fn() },
    feedbackService: { createFeedback: vi.fn(), getFeedback: vi.fn(), listFeedbacks: vi.fn(), updateFeedbackContent: vi.fn(), updateFeedbackStatus: vi.fn(), getFeedbackSnapshot: vi.fn() },
    feedbackDraftTasks: { create: vi.fn(), list: vi.fn(), get: vi.fn(), retry: vi.fn(), updateDraft: vi.fn() },
  };
}

async function invoke(deps: FeedbackGenerateRouteDependencies, path: string, method: 'get' | 'post' | 'patch', options: { body?: unknown; query?: unknown; params?: Record<string, string>; teacherId?: string } = {}) {
  const router = createFeedbackRouter(deps);
  const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> } }>).find(item => item.route?.path === path && item.route.methods[method]);
  if (!layer?.route) throw new Error(`missing ${method} ${path}`);
  let statusCode = 200; let responseBody: unknown;
  const req = { body: options.body, query: options.query ?? {}, params: options.params ?? {}, teacherId: options.teacherId } as unknown as Request;
  const res = { status(code: number) { statusCode = code; return this; }, json(value: unknown) { responseBody = value; return this; } } as Response;
  await layer.route.stack[0].handle(req, res);
  return { statusCode, responseBody };
}

const task = { id: 'task-1', studentId: 'student-1', status: 'succeeded', version: 2, attemptCount: 1, retryable: false,
  request: {}, draft: { title: '标题', content: '正文' }, generation: null, error: null, savedFeedbackId: null, createdAt: new Date(), updatedAt: new Date() };

describe('feedback draft task HTTP routes', () => {
  it('创建任务由认证 teacherId 注入并透传完整请求', async () => {
    const deps = dependencies(); (deps.feedbackDraftTasks.create as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ task, replayed: false }));
    const result = await invoke(deps, '/feedback/draft-tasks', 'post', { teacherId: 'teacher-a', body: { clientRequestId: 'request-a', studentId: 'student-1', recordIds: ['record-1'], tone: 'warm', title: '', content: '' } });
    expect(result.statusCode).toBe(201);
    expect(deps.feedbackDraftTasks.create).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'teacher-a', clientRequestId: 'request-a', recordIds: ['record-1'] }));
  });
  it.each([
    ['空数组', []],
    ['空白 lessonId', [' lesson-1 ', '   ']],
    ['重复 lessonId（按 trim 后判重）', ['lesson-1', ' lesson-1 ']],
  ])('创建任务在 %s 时返回 400 且不会调用任务服务', async (_caseName, lessonIds) => {
    const deps = dependencies();
    const result = await invoke(deps, '/feedback/draft-tasks', 'post', {
      teacherId: 'teacher-a',
      body: { clientRequestId: 'request-a', studentId: 'student-1', lessonIds },
    });
    expect(result.statusCode).toBe(400);
    expect(result.responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'lessonIds' } });
    expect(deps.feedbackDraftTasks.create).not.toHaveBeenCalled();
  });
  it('list 和 get 均实际命中草稿任务服务并固定教师范围', async () => {
    const deps = dependencies(); (deps.feedbackDraftTasks.list as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ items: [task] })); (deps.feedbackDraftTasks.get as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));
    const list = await invoke(deps, '/feedback/draft-tasks', 'get', { teacherId: 'teacher-a', query: { studentId: 'student-1' } });
    const get = await invoke(deps, '/feedback/draft-tasks/:taskId', 'get', { teacherId: 'teacher-a', params: { taskId: 'task-1' } });
    expect(list.statusCode).toBe(200); expect(get.statusCode).toBe(200);
    expect(deps.feedbackDraftTasks.list).toHaveBeenCalledWith({ teacherId: 'teacher-a', studentId: 'student-1' });
    expect(deps.feedbackDraftTasks.get).toHaveBeenCalledWith({ teacherId: 'teacher-a', taskId: 'task-1' });
  });
  it('真实 Express dispatch 的 /feedback/draft-tasks 不会被动态反馈路由吞掉', async () => {
    const deps = dependencies(); (deps.feedbackDraftTasks.list as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ items: [task] }));
    const app = express(); app.use((req, _res, next) => { (req as Request & { teacherId?: string }).teacherId = 'teacher-a'; next(); }); app.use(createFeedbackRouter(deps));
    const result = await request(app).get('/feedback/draft-tasks');
    expect(result.status).toBe(200);
    expect(deps.feedbackDraftTasks.list).toHaveBeenCalledWith({ teacherId: 'teacher-a', studentId: undefined });
    expect(deps.feedbackService.getFeedback).not.toHaveBeenCalled();
  });
  it('retry 与草稿编辑要求 CAS 版本并传给服务', async () => {
    const deps = dependencies(); (deps.feedbackDraftTasks.retry as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ task, replayed: false })); (deps.feedbackDraftTasks.updateDraft as ReturnType<typeof vi.fn>).mockResolvedValue(ok(task));
    const retry = await invoke(deps, '/feedback/draft-tasks/:taskId/retry', 'post', { teacherId: 'teacher-a', params: { taskId: 'task-1' }, body: { clientRequestId: 'retry-a', expectedVersion: 2 } });
    const update = await invoke(deps, '/feedback/draft-tasks/:taskId/draft', 'patch', { teacherId: 'teacher-a', params: { taskId: 'task-1' }, body: { expectedVersion: 2, title: '手改', content: '正文' } });
    expect(retry.statusCode).toBe(200); expect(update.statusCode).toBe(200);
    expect(deps.feedbackDraftTasks.retry).toHaveBeenCalledWith({ teacherId: 'teacher-a', taskId: 'task-1', clientRequestId: 'retry-a', expectedVersion: 2 });
    expect(deps.feedbackDraftTasks.updateDraft).toHaveBeenCalledWith({ teacherId: 'teacher-a', taskId: 'task-1', expectedVersion: 2, title: '手改', content: '正文' });
  });
});
