import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { notFound, ok, versionConflict } from '@teacher-platform/contracts';
import { createTeachingTaskRouter } from '../../src/app/routes/teaching-tasks.routes.js';
import type { TaskDTO, TeachingTaskService } from '../../src/features/teaching-tasks/index.js';

const task: TaskDTO = {
  id: 'task-1', conversationId: 'conversation-1', currentExecutionId: 'execution-1', title: null,
  status: 'unavailable', version: 1, createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z', lastError: { code: 'RUNTIME_UNAVAILABLE', message: 'unavailable', retryable: true },
  canResume: true, runtimeAvailability: 'unavailable',
};

function serviceDouble(): TeachingTaskService {
  return {
    createConversation: vi.fn(async () => ok({ id: 'conversation-1', createdAt: task.createdAt })),
    receiveMessage: vi.fn(async () => ok({
      task: { ...task, internalLeaseToken: 'must-not-leak' } as TaskDTO,
      receipt: { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'request-1', receivedAt: task.createdAt, workerSecret: 'must-not-leak' } as never,
      replayed: false,
    })),
    getTask: vi.fn(async ({ teacherId }: { teacherId: string; taskId: string }) => teacherId === 'teacher-a'
      ? ok({ task, executions: [{ id: 'execution-1', status: 'unavailable', clientRequestId: 'request-1', createdAt: task.createdAt }], steps: [] })
      : ({ ok: false, error: notFound('教学任务不存在') })),
    listTasks: vi.fn(async () => ok({ items: [task], nextCursor: null })),
    listTaskEvents: vi.fn(async () => ok({ items: [{ seq: 1, eventKey: 'event-1', eventKind: 'message_received' as const, executionId: 'execution-1', role: 'user' as const, content: '消息已收到', createdAt: task.createdAt }], nextSeq: null })),
    resume: vi.fn(async () => ({ ok: false, error: versionConflict() })),
    claim: vi.fn(), heartbeat: vi.fn(), prepareStep: vi.fn(), completeStep: vi.fn(), failStep: vi.fn(), finish: vi.fn(),
  } as unknown as TeachingTaskService;
}

function appFor(service: TeachingTaskService) {
  const app = express();
  app.use(express.json());
  // Test-only stand-in for requireAuth: production auth middleware is the sole
  // writer of req.teacherId; the route itself never reads this header.
  app.use((req, _res, next) => {
    (req as express.Request & { teacherId?: string }).teacherId = req.header('x-teacher-id') ?? undefined;
    next();
  });
  app.use(createTeachingTaskRouter(service));
  return app;
}

describe('teaching task HTTP routes', () => {
  it('requires session identity and ignores forged body/header identities', async () => {
    const service = serviceDouble();
    const app = appFor(service);
    expect((await request(app).post('/teaching-tasks').send({ conversationId: 'conversation-1', clientRequestId: 'request-1', message: 'hello', teacherId: 'teacher-a' })).status).toBe(401);
    const response = await request(app).post('/teaching-tasks').set('x-teacher-id', 'teacher-a').send({ conversationId: 'conversation-1', clientRequestId: 'request-1', message: 'hello' });
    expect(response.status).toBe(202);
    expect(service.receiveMessage).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'teacher-a' }));
  });

  it('reports the configured runtime capability without exposing provider details', async () => {
    const service = serviceDouble();
    const app = appFor(service);
    expect((await request(app).get('/teaching-runtime')).status).toBe(401);
    const response = await request(app).get('/teaching-runtime').set('x-teacher-id', 'teacher-a');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: { runtimeAvailability: 'unavailable' } });
  });

  it('wakes an available worker only after a newly queued task is durably accepted', async () => {
    const service = serviceDouble();
    (service.receiveMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, value: {
      task: { ...task, status: 'queued', runtimeAvailability: 'available' },
      receipt: { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'request-1', receivedAt: task.createdAt },
      replayed: false,
    }});
    const worker = {
      availability: 'ready' as const,
      wake: vi.fn(() => ok({ queued: true })),
      runOnce: vi.fn(async () => ok({ ran: true, pending: false, status: 'succeeded', executionId: 'execution-1' })),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as express.Request & { teacherId?: string }).teacherId = 'teacher-a'; next(); });
    app.use(createTeachingTaskRouter(service, { runtimeWorker: worker }));
    const response = await request(app).post('/teaching-tasks').send({ conversationId: 'conversation-1', clientRequestId: 'request-1', message: 'hello' });
    expect(response.status).toBe(202);
    expect(worker.wake).toHaveBeenCalledWith({ teacherId: 'teacher-a', taskId: 'task-1' });
    expect(worker.runOnce).toHaveBeenCalledTimes(1);
  });

  it('returns 202 for the first receipt and 200 for a replay', async () => {
    const service = serviceDouble();
    const receive = service.receiveMessage as ReturnType<typeof vi.fn>;
    receive.mockResolvedValueOnce({ ok: true, value: { task, receipt: { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'request-1', receivedAt: task.createdAt }, replayed: false } });
    receive.mockResolvedValueOnce({ ok: true, value: { task, receipt: { executionId: 'execution-1', userTurnId: 'turn-1', clientRequestId: 'request-1', receivedAt: task.createdAt }, replayed: true } });
    const app = appFor(service);
    const body = { conversationId: 'conversation-1', clientRequestId: 'request-1', message: 'hello' };
    expect((await request(app).post('/teaching-tasks').set('x-teacher-id', 'teacher-a').send(body)).status).toBe(202);
    expect((await request(app).post('/teaching-tasks').set('x-teacher-id', 'teacher-a').send(body)).status).toBe(200);
  });

  it('loads conversationId from the owned task and rejects internal fields', async () => {
    const service = serviceDouble();
    const app = appFor(service);
    const rejected = await request(app).post('/teaching-tasks').set('x-teacher-id', 'teacher-a').send({ conversationId: 'forged', clientRequestId: 'request-1', message: 'hello', runtimeAvailability: 'test_only' });
    expect(rejected.status).toBe(400);
    const continued = await request(app).post('/teaching-tasks/task-1/messages').set('x-teacher-id', 'teacher-a').send({ clientRequestId: 'request-2', message: 'continue', expectedVersion: 1 });
    expect(continued.status).toBe(202);
    expect(service.receiveMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-1', taskId: 'task-1', teacherId: 'teacher-a' }));
    expect(continued.body.data.task.internalLeaseToken).toBeUndefined();
    for (const field of ['kind', 'sourceRefs', 'confirmation', 'leaseToken']) {
      const response = await request(app).post('/teaching-tasks').set('x-teacher-id', 'teacher-a').send({
        conversationId: 'conversation-1', clientRequestId: `request-${field}`, message: 'hello', [field]: 'internal',
      });
      expect(response.status, field).toBe(400);
    }
  });

  it('parses HTTP query integers and rejects arrays, whitespace, decimals, and overflow', async () => {
    const service = serviceDouble();
    const app = appFor(service);
    expect((await request(app).get('/teaching-tasks?limit=20&conversationId=conversation-1').set('x-teacher-id', 'teacher-a')).status).toBe(200);
    expect((await request(app).get('/teaching-tasks/task-1/events?afterSeq=0&limit=20').set('x-teacher-id', 'teacher-a')).status).toBe(200);
    for (const query of ['limit[]=20', 'limit=%2020', 'limit=1.5', 'limit=9007199254740992', 'afterSeq[]=0', 'afterSeq=%200', 'afterSeq=1.5', 'afterSeq=9007199254740992']) {
      const path = query.startsWith('afterSeq') ? `/teaching-tasks/task-1/events?${query}` : `/teaching-tasks?${query}`;
      expect((await request(app).get(path).set('x-teacher-id', 'teacher-a')).status, query).toBe(400);
    }
  });

  it('maps service conflicts to 409 and cross-teacher task access to 404', async () => {
    const service = serviceDouble();
    const app = appFor(service);
    const conflict = await request(app).post('/teaching-tasks/task-1/resume').set('x-teacher-id', 'teacher-a').send({ executionId: 'execution-1', expectedVersion: 1 });
    expect(conflict.status).toBe(409);
    const crossed = await request(app).get('/teaching-tasks/task-1').set('x-teacher-id', 'teacher-b');
    expect(crossed.status).toBe(404);
  });
});
