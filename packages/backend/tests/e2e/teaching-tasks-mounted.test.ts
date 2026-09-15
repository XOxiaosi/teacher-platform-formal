import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCoreRouter } from '../../src/app/routes/core.routes.js';

const prisma = new PrismaClient();
const TEACHER_A = 'a01-mounted-teacher-a';
const TEACHER_B = 'a01-mounted-teacher-b';

function appFor(teacherId: string) {
  const app = express();
  app.use(express.json());
  // Test-only authentication boundary: identity is injected from this closure,
  // never accepted from request headers or JSON.
  app.use((req, _res, next) => {
    (req as express.Request & { teacherId?: string }).teacherId = teacherId;
    next();
  });
  app.use('/api/v1', createCoreRouter(prisma, { localSafeMode: true }));
  return app;
}

async function cleanup(): Promise<void> {
  const teachers = { in: [TEACHER_A, TEACHER_B] };
  await prisma.stepReceipt.deleteMany({ where: { teacherId: teachers } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: teachers } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId: teachers } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: teachers } });
  await prisma.conversation.deleteMany({ where: { teacherId: teachers } });
}

beforeAll(async () => { await cleanup(); });
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('mounted teaching task routes with real Prisma service', () => {
  it('persists dsh-v1 task receipts, events, CAS continuation, and idempotency', async () => {
    const app = appFor(TEACHER_A);
    const conversationResponse = await request(app).post('/api/v1/teaching-conversations').send({});
    expect(conversationResponse.status).toBe(201);
    const conversationId = conversationResponse.body.data.id as string;
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).runtimeOwner).toBe('dsh-v1');

    const firstBody = { conversationId, clientRequestId: 'a01-request-1', message: '  请整理本次课后反馈  ' };
    const first = await request(app).post('/api/v1/teaching-tasks').send(firstBody);
    expect(first.status).toBe(202);
    expect(first.body.data.replayed).toBe(false);
    const taskId = first.body.data.task.id as string;
    const firstIds = [first.body.data.task.id, first.body.data.receipt.executionId, first.body.data.receipt.userTurnId];

    const replay = await request(app).post('/api/v1/teaching-tasks').send(firstBody);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect([replay.body.data.task.id, replay.body.data.receipt.executionId, replay.body.data.receipt.userTurnId]).toEqual(firstIds);

    const fingerprintConflict = await request(app).post('/api/v1/teaching-tasks').send({ ...firstBody, message: '另一条消息' });
    expect(fingerprintConflict.status).toBe(409);
    expect(fingerprintConflict.body.error.code).toBe('VERSION_CONFLICT');

    const beforeMissingVersion = await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } });
    const missingVersion = await request(app).post(`/api/v1/teaching-tasks/${taskId}/messages`).send({ clientRequestId: 'a01-request-2', message: '继续整理' });
    expect(missingVersion.status).toBe(400);
    expect(await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } })).toBe(beforeMissingVersion);

    const continued = await request(app).post(`/api/v1/teaching-tasks/${taskId}/messages`).send({ clientRequestId: 'a01-request-2', message: '继续整理', expectedVersion: first.body.data.task.version });
    expect(continued.status).toBe(202);
    expect(continued.body.data.task.version).toBe(first.body.data.task.version + 1);

    const detail = await request(app).get(`/api/v1/teaching-tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.task.runtimeAvailability).toBe('unavailable');
    expect(detail.body.data.task.leaseToken).toBeUndefined();
    expect(detail.body.data.task.dshCheckpoint).toBeUndefined();
    expect(detail.body.data.executions).toHaveLength(2);

    const events = await request(app).get(`/api/v1/teaching-tasks/${taskId}/events`);
    expect(events.status).toBe(200);
    expect(events.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(events.body.data.items.map((event: { seq: number }) => event.seq)).toEqual(
      [...events.body.data.items].map((event: { seq: number }) => event.seq).sort((a: number, b: number) => a - b),
    );
    const userEvents = events.body.data.items.filter((event: { executionId: string; eventKind: string; role: string; content: string }) => event.executionId === first.body.data.receipt.executionId && event.eventKind === 'message_received' && event.role === 'user');
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].content).toBe(firstBody.message);
    expect(new Set(events.body.data.items.map((event: { eventKey: string }) => event.eventKey)).size).toBe(events.body.data.items.length);
    const queriedEvents = await request(app).get(`/api/v1/teaching-tasks/${taskId}/events?afterSeq=0&limit=20`);
    expect(queriedEvents.status).toBe(200);
    expect(queriedEvents.body.data.items.length).toBe(events.body.data.items.length);
    const queriedList = await request(app).get('/api/v1/teaching-tasks?conversationId=' + conversationId + '&limit=20');
    expect(queriedList.status).toBe(200);
    expect(queriedList.body.data.items.map((item: { id: string }) => item.id)).toContain(taskId);

    const rebuilt = appFor(TEACHER_A);
    expect((await request(rebuilt).get(`/api/v1/teaching-tasks/${taskId}`)).status).toBe(200);
    expect((await request(rebuilt).get(`/api/v1/teaching-tasks/${taskId}/events`)).body.data.items.length).toBe(events.body.data.items.length);

    expect(await prisma.taskRuntime.count({ where: { teacherId: TEACHER_A } })).toBe(1);
    expect(await prisma.agentExecution.count({ where: { teacherId: TEACHER_A } })).toBe(2);
    expect(await prisma.conversationTurn.count({ where: { teacherId: TEACHER_A, taskId } })).toBe(events.body.data.items.length);
    expect(events.body.data.items.filter((event: { role: string }) => event.role === 'user')).toHaveLength(2);
    expect(events.body.data.items.filter((event: { eventKind: string }) => event.eventKind === 'task_state')).toHaveLength(2);
  });

  it('isolates teachers and rejects client runtime/internal fields', async () => {
    const ownerApp = appFor(TEACHER_A);
    const otherApp = appFor(TEACHER_B);
    const conversationResponse = await request(ownerApp).post('/api/v1/teaching-conversations').send({});
    const conversationId = conversationResponse.body.data.id as string;
    const created = await request(ownerApp).post('/api/v1/teaching-tasks').send({ conversationId, clientRequestId: 'a01-request-7', message: '隔离测试' });
    const taskId = created.body.data.task.id as string;

    expect((await request(otherApp).get(`/api/v1/teaching-tasks/${taskId}`)).status).toBe(404);
    expect((await request(otherApp).post('/api/v1/teaching-tasks').send({ conversationId, clientRequestId: 'a01-request-3', message: '越权' })).status).toBe(404);
    expect((await request(ownerApp).post('/api/v1/teaching-tasks').send({ conversationId, clientRequestId: 'a01-request-4', message: '非法', runtimeAvailability: 'test_only' })).status).toBe(400);
    expect((await request(ownerApp).post('/api/v1/teaching-tasks').send({ conversationId, clientRequestId: 'a01-request-5', message: '非法', materialRefs: [{ type: 'lesson', id: 'x', version: '1' }] })).status).toBe(400);
    expect((await request(ownerApp).post('/api/v1/teaching-tasks').send({ conversationId, clientRequestId: 'a01-request-6', message: '非法', teacherId: TEACHER_B })).status).toBe(400);
  });
});
