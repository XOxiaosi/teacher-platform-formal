import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createCoreRouteDependencies } from '../../src/app/composition/core-route-dependencies.js';
import { createTeachingTaskRuntimeWorker } from '../../src/app/teaching-runtime/teaching-task-runtime-worker.js';
import { createSyntheticTeachingRuntime } from '../../src/app/teaching-runtime/synthetic-runtime-driver.js';
import {
  createUnavailableTeachingRuntime,
  toTaskRuntimeAvailability,
  type TeachingRuntimeDriver,
  type TeachingRuntimeInput,
} from '../../src/app/teaching-runtime/runtime-driver.js';
import { createTeachingTaskService } from '../../src/features/teaching-tasks/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
import { acceptInvitation } from '../helpers/invitations.js';

/**
 * A02-RUNTIME-HTTP-01：在真实认证 HTTP 与 Prisma 临时测试库之间验证
 * TeachingTask 的持久接收、合成 runtime 唤醒、检查点续跑与不可用边界。
 *
 * 这里的 driver 仅是明确标注为 test_only 的 local synthetic adapter；不接入
 * DeepSeek、DSH 插件、真实教师资料或外部网络。
 */
const prisma = new PrismaClient();
const createdTeacherIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdTeacherIds.length === 0) return;
  const teachers = { in: createdTeacherIds };
  await prisma.stepReceipt.deleteMany({ where: { teacherId: teachers } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: teachers } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId: teachers } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: teachers } });
  await prisma.conversation.deleteMany({ where: { teacherId: teachers } });
  await prisma.student.deleteMany({ where: { teacherId: teachers } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: teachers } });
  await prisma.teacherRegistry.deleteMany({ where: { id: teachers } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { startsWith: 'a02-runtime-http-' } } });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function createRuntimeApp(client: PrismaClient, driver: TeachingRuntimeDriver) {
  const cipher = createFieldCipher(loadEncryptionKey().key);
  // The runner owns a separate service object so the test verifies the same
  // durable rows across the HTTP composition and worker composition boundary.
  const runnerTasks = createTeachingTaskService({
    prisma: client,
    cipher,
    runtimeAvailability: toTaskRuntimeAvailability(driver.availability),
  });
  const worker = createTeachingTaskRuntimeWorker({
    driver,
    runnerOptions: { prisma: client, tasks: runnerTasks, cipher },
  });
  const dependencies = createCoreRouteDependencies(client, {
    localSafeMode: true,
    teachingRuntimeWorker: worker,
  });
  return {
    app: createApp(client, {
      rawPrisma: client,
      localSafeMode: true,
      coreDependencies: dependencies,
      rateLimitMiddleware: null,
      agentTeacherRateLimit: null,
    }),
  };
}

async function waitForTask(
  app: ReturnType<typeof createRuntimeApp>['app'],
  cookie: string,
  taskId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(app)
      .get(`/api/v1/teaching-tasks/${taskId}`)
      .set('Cookie', cookie);
    if (response.status === 200 && response.body.data.task.status === status) return response;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach ${status}`);
}

describe('A02 合成教学 Runtime 认证 HTTP 闭环', () => {
  it('接收后唤醒 worker，保留只读步骤与 checkpoint，并在重建后由新消息续跑且不重复执行', async () => {
    let firstRuns = 0;
    const firstBase = createSyntheticTeachingRuntime({ actions: [
      { type: 'query', tool: 'students.list', args: {} },
      { type: 'pause' },
    ] });
    const firstDriver: TeachingRuntimeDriver = {
      ...firstBase,
      async run(input) {
        firstRuns += 1;
        return firstBase.run(input);
      },
    };
    const initial = createRuntimeApp(prisma, firstDriver);
    const suffix = randomBytes(6).toString('hex');
    const owner = (await acceptInvitation(initial.app, prisma, {
      email: `a02-runtime-http-owner-${suffix}@example.com`,
      displayName: 'A02 合成教师',
    })).response;
    const other = (await acceptInvitation(initial.app, prisma, {
      email: `a02-runtime-http-other-${suffix}@example.com`,
      displayName: 'A02 隔离教师',
    })).response;
    expect(owner.status).toBe(201);
    expect(other.status).toBe(201);
    const teacherId = owner.body.data.teacher.id as string;
    const otherTeacherId = other.body.data.teacher.id as string;
    createdTeacherIds.push(teacherId, otherTeacherId);
    const ownerCookie = owner.headers['set-cookie'][0].split(';')[0];
    const otherCookie = other.headers['set-cookie'][0].split(';')[0];
    const ownerStudent = await prisma.student.create({
      data: { teacherId, name: 'A02 仅属主教师的学生', grade: '高一', source: 'synthetic' },
    });
    const otherStudent = await prisma.student.create({
      data: { teacherId: otherTeacherId, name: 'A02 不应泄露的学生', grade: '高二', source: 'synthetic' },
    });

    const conversation = await request(initial.app)
      .post('/api/v1/teaching-conversations')
      .set('Cookie', ownerCookie)
      .send({});
    expect(conversation.status).toBe(201);
    const conversationId = conversation.body.data.id as string;
    const firstMessage = {
      conversationId,
      clientRequestId: `a02-runtime-first-${suffix}`,
      message: '先读取我的学生列表，再等我补充下一步。',
    };
    const accepted = await request(initial.app)
      .post('/api/v1/teaching-tasks')
      .set('Cookie', ownerCookie)
      .send(firstMessage);
    expect(accepted.status).toBe(202);
    expect(accepted.body.data).toMatchObject({
      replayed: false,
      task: { status: 'queued', runtimeAvailability: 'test_only' },
    });
    const taskId = accepted.body.data.task.id as string;

    const waiting = await waitForTask(initial.app, ownerCookie, taskId, 'waiting_input');
    expect(firstRuns).toBe(1);
    expect(waiting.body.data.task).toMatchObject({
      status: 'waiting_input',
      runtimeAvailability: 'test_only',
    });
    expect(waiting.body.data.task).not.toHaveProperty('dshCheckpoint');
    expect(waiting.body.data.task).not.toHaveProperty('dshSessionRef');
    expect(waiting.body.data.task).not.toHaveProperty('leaseToken');
    expect(waiting.body.data.task).not.toHaveProperty('leaseEpoch');
    expect(waiting.body.data.task).not.toHaveProperty('leaseExpiresAtTs');
    expect(waiting.body.data.steps).toEqual([
      expect.objectContaining({ kind: 'query', status: 'succeeded' }),
    ]);
    expect(waiting.body.data.steps[0].result).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: ownerStudent.id, teacherId, name: ownerStudent.name })],
    });
    expect(JSON.stringify(waiting.body.data.steps[0].result)).not.toContain(otherStudent.id);
    const persistedWaiting = await prisma.taskRuntime.findUniqueOrThrow({ where: { id: taskId } });
    expect(persistedWaiting).toMatchObject({
      teacherId,
      status: 'waiting_input',
      dshSessionRef: `synthetic:${taskId}`,
    });
    expect(String(persistedWaiting.dshCheckpoint)).toMatch(/^enc:v1:/);
    expect(await prisma.stepReceipt.findFirstOrThrow({ where: { taskId } })).toMatchObject({
      teacherId,
      status: 'succeeded',
      attemptCount: 1,
    });

    const eventsBeforeRestart = await request(initial.app)
      .get(`/api/v1/teaching-tasks/${taskId}/events`)
      .set('Cookie', ownerCookie);
    expect(eventsBeforeRestart.status).toBe(200);
    expect(eventsBeforeRestart.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: 'message_received', role: 'user' }),
      expect.objectContaining({ eventKind: 'step_result', role: 'tool' }),
      expect.objectContaining({ eventKind: 'assistant_message', role: 'assistant' }),
    ]));
    expect(new Set(eventsBeforeRestart.body.data.items.map((event: { eventKey: string }) => event.eventKey)).size)
      .toBe(eventsBeforeRestart.body.data.items.length);
    expect(eventsBeforeRestart.body.data.items.map((event: { seq: number }) => event.seq)).toEqual(
      [...eventsBeforeRestart.body.data.items]
        .map((event: { seq: number }) => event.seq)
        .sort((left: number, right: number) => left - right),
    );

    const replay = await request(initial.app)
      .post('/api/v1/teaching-tasks')
      .set('Cookie', ownerCookie)
      .send(firstMessage);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({ replayed: true, task: { id: taskId } });
    expect(firstRuns).toBe(1);
    expect(await prisma.agentExecution.count({ where: { teacherId } })).toBe(1);
    expect(await prisma.stepReceipt.count({ where: { teacherId, taskId } })).toBe(1);

    const isolatedRead = await request(initial.app)
      .get(`/api/v1/teaching-tasks/${taskId}`)
      .set('Cookie', otherCookie);
    expect(isolatedRead.status).toBe(404);
    expect((await request(initial.app)
      .get(`/api/v1/teaching-tasks/${taskId}/events`)
      .set('Cookie', otherCookie)).status).toBe(404);
    expect((await request(initial.app)
      .post(`/api/v1/teaching-tasks/${taskId}/messages`)
      .set('Cookie', otherCookie)
      .send({
        clientRequestId: `a02-runtime-foreign-${suffix}`,
        message: '不得接管其他教师的任务。',
        expectedVersion: waiting.body.data.task.version,
      })).status).toBe(404);
    const isolatedList = await request(initial.app)
      .get(`/api/v1/teaching-tasks?conversationId=${encodeURIComponent(conversationId)}`)
      .set('Cookie', otherCookie);
    expect(isolatedList.status).toBe(200);
    expect(isolatedList.body.data.items).toEqual([]);
    expect((await request(initial.app)
      .post(`/api/v1/teaching-tasks/${taskId}/resume`)
      .set('Cookie', otherCookie)
      .send({
        executionId: accepted.body.data.receipt.executionId,
        expectedVersion: waiting.body.data.task.version,
      })).status).toBe(404);

    const restartedPrisma = new PrismaClient();
    const checkpoints: Array<TeachingRuntimeInput['checkpoint']> = [];
    const sessionRefs: Array<TeachingRuntimeInput['sessionRef']> = [];
    const histories: Array<TeachingRuntimeInput['history']> = [];
    let resumedRuns = 0;
    const resumedBase = createSyntheticTeachingRuntime({
      actions: [{ type: 'reply', content: '已根据已保存的上下文继续完成。' }],
    });
    const resumedDriver: TeachingRuntimeDriver = {
      ...resumedBase,
      async run(input) {
        resumedRuns += 1;
        checkpoints.push(input.checkpoint);
        sessionRefs.push(input.sessionRef);
        histories.push(input.history);
        return resumedBase.run(input);
      },
    };
    try {
      const restarted = createRuntimeApp(restartedPrisma, resumedDriver);
      const continuedBody = {
        clientRequestId: `a02-runtime-continue-${suffix}`,
        message: '学生名单已确认，请继续。',
        expectedVersion: waiting.body.data.task.version as number,
      };
      const continued = await request(restarted.app)
        .post(`/api/v1/teaching-tasks/${taskId}/messages`)
        .set('Cookie', ownerCookie)
        .send(continuedBody);
      expect(continued.status).toBe(202);
      expect(continued.body.data).toMatchObject({ replayed: false, task: { status: 'queued' } });
      const completed = await waitForTask(restarted.app, ownerCookie, taskId, 'succeeded');
      expect(resumedRuns).toBe(1);
      expect(checkpoints).toEqual([
        expect.objectContaining({ schemaVersion: 1, runtimeVersion: 'dsh-v1', contextEpoch: 0 }),
      ]);
      expect(sessionRefs).toEqual([`synthetic:${taskId}`]);
      expect(histories).toEqual([[
        { role: 'user', content: firstMessage.message },
        { role: 'assistant', content: '需要补充信息后才能继续。' },
        { role: 'user', content: continuedBody.message },
      ]]);
      expect(completed.body.data.task).toMatchObject({
        status: 'succeeded',
        runtimeAvailability: 'test_only',
      });
      expect(completed.body.data.task).not.toHaveProperty('dshCheckpoint');
      expect(completed.body.data.task).not.toHaveProperty('dshSessionRef');
      expect(completed.body.data.task).not.toHaveProperty('leaseToken');
      expect(completed.body.data.executions).toHaveLength(2);
      expect((await restartedPrisma.taskRuntime.findUniqueOrThrow({ where: { id: taskId } })).dshSessionRef)
        .toBe(`synthetic:${taskId}`);

      const eventsAfterRestart = await request(restarted.app)
        .get(`/api/v1/teaching-tasks/${taskId}/events`)
        .set('Cookie', ownerCookie);
      expect(eventsAfterRestart.status).toBe(200);
      expect(eventsAfterRestart.body.data.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventKind: 'assistant_message', role: 'assistant', content: '已根据已保存的上下文继续完成。' }),
      ]));
      expect(new Set(eventsAfterRestart.body.data.items.map((event: { eventKey: string }) => event.eventKey)).size)
        .toBe(eventsAfterRestart.body.data.items.length);
      expect(eventsAfterRestart.body.data.items.map((event: { seq: number }) => event.seq)).toEqual(
        [...eventsAfterRestart.body.data.items]
          .map((event: { seq: number }) => event.seq)
          .sort((left: number, right: number) => left - right),
      );

      const continuationReplay = await request(restarted.app)
        .post(`/api/v1/teaching-tasks/${taskId}/messages`)
        .set('Cookie', ownerCookie)
        .send(continuedBody);
      expect(continuationReplay.status).toBe(200);
      expect(continuationReplay.body.data).toMatchObject({ replayed: true });
      expect(resumedRuns).toBe(1);
      expect(await restartedPrisma.agentExecution.count({ where: { teacherId } })).toBe(2);
    } finally {
      await restartedPrisma.$disconnect();
    }
  });

  it('runtime unavailable 时只持久回执，不唤醒 driver 或伪造成功', async () => {
    let unavailableRuns = 0;
    const unavailableBase = createUnavailableTeachingRuntime();
    const unavailableDriver: TeachingRuntimeDriver = {
      ...unavailableBase,
      async run(input) {
        unavailableRuns += 1;
        return unavailableBase.run(input);
      },
    };
    const unavailable = createRuntimeApp(prisma, unavailableDriver);
    const suffix = randomBytes(6).toString('hex');
    const owner = (await acceptInvitation(unavailable.app, prisma, {
      email: `a02-runtime-http-unavailable-${suffix}@example.com`,
      displayName: 'A02 不可用教师',
    })).response;
    expect(owner.status).toBe(201);
    const teacherId = owner.body.data.teacher.id as string;
    createdTeacherIds.push(teacherId);
    const cookie = owner.headers['set-cookie'][0].split(';')[0];

    const runtime = await request(unavailable.app)
      .get('/api/v1/teaching-runtime')
      .set('Cookie', cookie);
    expect(runtime.body).toEqual({ ok: true, data: { runtimeAvailability: 'unavailable' } });
    const conversation = await request(unavailable.app)
      .post('/api/v1/teaching-conversations')
      .set('Cookie', cookie)
      .send({});
    const accepted = await request(unavailable.app)
      .post('/api/v1/teaching-tasks')
      .set('Cookie', cookie)
      .send({
        conversationId: conversation.body.data.id,
        clientRequestId: `a02-runtime-unavailable-${suffix}`,
        message: '请保存，但不要虚构已经完成。',
      });
    expect(accepted.status).toBe(202);
    expect(accepted.body.data).toMatchObject({
      replayed: false,
      task: { status: 'unavailable', runtimeAvailability: 'unavailable' },
    });
    const taskId = accepted.body.data.task.id as string;
    const detail = await request(unavailable.app)
      .get(`/api/v1/teaching-tasks/${taskId}`)
      .set('Cookie', cookie);
    const events = await request(unavailable.app)
      .get(`/api/v1/teaching-tasks/${taskId}/events`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.task.status).toBe('unavailable');
    expect(detail.body.data.steps).toHaveLength(0);
    expect(events.body.data.items.some((event: { eventKind: string }) => event.eventKind === 'assistant_message')).toBe(false);
    expect(unavailableRuns).toBe(0);
    expect(await prisma.taskRuntime.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'unavailable',
      attemptCount: 0,
      leaseEpoch: 0,
      leaseToken: null,
      leaseExpiresAtTs: null,
    });
    expect(await prisma.agentExecution.findMany({ where: { teacherId, taskId } })).toEqual([
      expect.objectContaining({
        id: accepted.body.data.receipt.executionId,
        status: 'unavailable',
        stage: 'conversation',
        finishedAtTs: null,
      }),
    ]);
    expect(await prisma.stepReceipt.count({ where: { teacherId } })).toBe(0);
  });
});
