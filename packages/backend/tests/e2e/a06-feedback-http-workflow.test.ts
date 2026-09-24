import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createApp } from '../../src/index.js';
import { createCoreRouteDependencies } from '../../src/app/composition/core-route-dependencies.js';
import { createAssembleParentFeedbackContextUseCase } from '../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
import { createGenerateFeedbackDraftUseCase } from '../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js';
import { createFeedbackDraftTaskService } from '../../src/features/feedback/index.js';
import { createFieldCipherFromEnv, encryptFieldValue, encryptJsonFieldValue } from '../../src/shared/field-encryption/index.js';
import type { AiClient, ChatMessage, ChatToolDefinition } from '../../src/shared/ai-client/types.js';
import { acceptInvitation } from '../helpers/invitations.js';

const prisma = new PrismaClient();
const cipher = createFieldCipherFromEnv();

/** 新服务上下文必须重新装配依赖；不能仅复用原 app 对象模拟重启。 */
function createTestApp(client: PrismaClient) {
  const baseDependencies = createCoreRouteDependencies(client, { localSafeMode: true });
  const context = createAssembleParentFeedbackContextUseCase({ prisma: client, cipher });
  const generator = createGenerateFeedbackDraftUseCase({
    prisma: client,
    cipher,
    context,
    aiClient: {
      run: async () => ok({}),
      chat: async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => ok({
        content: '标题：本次课堂的主动验算\n内容：本次课小雨独立完成三道计算题，并主动检查了每一步。接下来继续练习验算。\n所以这样写：用具体课堂行为让家长看见可延续的进展。',
      }),
    } as unknown as AiClient,
  });
  const feedbackDraftTasks = createFeedbackDraftTaskService({
    prisma: client,
    getClient: async () => client,
    cipher,
    context,
    generator,
  });
  return createApp(client, {
    localSafeMode: true,
    coreDependencies: {
      ...baseDependencies,
      feedback: { ...baseDependencies.feedback, feedbackDraftTasks },
    },
  });
}

const app = createTestApp(prisma);

const teacherIds: string[] = [];
const studentIds: string[] = [];

async function cleanup() {
  if (teacherIds.length === 0) return;
  await prisma.feedbackDraftAttempt.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.feedbackDraftTask.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.captureDeletionReceipt.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.captureCandidate.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.captureTask.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.captureEvent.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.teacherInvitation.deleteMany({ where: { email: { contains: 'a06-http-' } } });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('A06 反馈正式认证 HTTP 合成闭环', () => {
  it('认证登录 → 生成待核对草稿 → 明确保存 → 幂等重放 → 读取依据快照', async () => {
    const email = `a06-http-${randomBytes(6).toString('hex')}@example.com`;
    const accepted = await acceptInvitation(app, prisma, {
      email,
      password: 'password123',
      displayName: 'A06 HTTP 教师',
    });
    expect(accepted.response.status).toBe(201);
    const teacherId = accepted.response.body.data.teacher.id as string;
    teacherIds.push(teacherId);
    const cookie = accepted.response.headers['set-cookie'][0].split(';')[0];

    const studentResponse = await request(app)
      .post('/api/v1/students')
      .set('Cookie', cookie)
      .send({ name: 'A06 合成学生', grade: '高一' });
    expect(studentResponse.status).toBe(201);
    const studentId = studentResponse.body.data.id as string;
    studentIds.push(studentId);

    const start = new Date('2026-09-15T10:00:00.000Z');
    const schedule = await prisma.schedule.create({
      data: {
        teacherId,
        studentId,
        type: 'lesson',
        title: 'A06 HTTP 合成课次',
        scheduledStartTs: start,
        scheduledEndTs: new Date(start.getTime() + 90 * 60 * 1000),
      },
    });
    const lesson = await prisma.lesson.create({
      data: {
        teacherId,
        studentId,
        scheduleId: schedule.id,
        dateTs: start,
        status: 'attended',
        progress: '独立完成三道计算题并主动验算',
      },
    });
    const record = await prisma.studentRecord.create({
      data: {
        teacherId,
        studentId,
        category: 'lesson_observation',
        summary: encryptFieldValue(cipher, '独立完成三道计算题并主动验算'),
        structuredData: { lessonId: lesson.id, scheduleId: schedule.id },
        occurredAtTs: start,
        reviewStatus: 'confirmed',
        visibility: 'parent_shareable',
      },
    });

    const generated = await request(app)
      .post('/api/v1/feedback/draft-tasks')
      .set('Cookie', cookie)
      .send({ clientRequestId: 'a06-http-generate-0001', studentId, lessonIds: [lesson.id], focus: 'highlight' });
    expect(generated.status).toBe(201);
    expect(generated.body.data.task.error).toBeNull();
    expect(generated.body.data).toMatchObject({ replayed: false, task: {
      studentId,
      status: 'succeeded',
      draft: { title: '本次课堂的主动验算' },
      generation: { lessonIds: [lesson.id] },
    } });
    expect(generated.body.data.task.generation.evidence.map((item: { id: string }) => item.id)).toEqual([record.id]);
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(0);

    const saveBody = {
      studentId,
      title: generated.body.data.task.draft.title,
      content: '老师核对后的反馈：小雨主动验算，下一次继续保持。',
      channel: 'manual-copy',
      parentName: '合成家长',
      clientRequestId: 'a06-http-save-0001',
      generationTaskId: generated.body.data.task.id,
    };
    const saved = await request(app)
      .post('/api/v1/feedback')
      .set('Cookie', cookie)
      .send(saveBody);
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({
      teacherId,
      studentId,
      lessonId: lesson.id,
      status: 'draft',
      channel: 'manual-copy',
      parentName: '合成家长',
      sentAt: null,
      replayed: false,
    });
    const feedbackId = saved.body.data.id as string;
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(1);

    const replay = await request(app)
      .post('/api/v1/feedback')
      .set('Cookie', cookie)
      .send(saveBody);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toMatchObject({ id: feedbackId, replayed: true });
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(1);

    const snapshot = await request(app)
      .get(`/api/v1/feedback/${feedbackId}/snapshot`)
      .set('Cookie', cookie);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.evidence).toHaveLength(1);
    expect(snapshot.body.data.evidence[0]).toMatchObject({ id: record.id, sourceVersion: expect.any(String) });
    expect(snapshot.body.data.evidence[0].summary).toContain('独立完成三道计算题');
  });

  it('材料确认时显式允许家长表达后可直接生成反馈，确认和保存重放均不重复写入', async () => {
    const email = `a06-http-${randomBytes(6).toString('hex')}@example.com`;
    const accepted = await acceptInvitation(app, prisma, {
      email,
      password: 'password123',
      displayName: 'A06 材料反馈教师',
    });
    expect(accepted.response.status).toBe(201);
    const teacherId = accepted.response.body.data.teacher.id as string;
    teacherIds.push(teacherId);
    const cookie = accepted.response.headers['set-cookie'][0].split(';')[0];

    const studentResponse = await request(app)
      .post('/api/v1/students')
      .set('Cookie', cookie)
      .send({ name: 'A06 材料学生', grade: '五年级' });
    expect(studentResponse.status).toBe(201);
    const studentId = studentResponse.body.data.id as string;
    studentIds.push(studentId);

    const captured = await request(app)
      .post('/api/v1/captures')
      .set('Cookie', cookie)
      .send({
        clientRequestId: 'a06-capture-create-0001',
        sourceType: 'text',
        text: '今天独立完成三道计算题，并主动检查了每一步。',
      });
    expect(captured.status).toBe(201);
    const captureId = captured.body.data.capture.id as string;
    const candidate = captured.body.data.capture.candidate as { id: string; version: number };
    const confirmBody = {
      clientRequestId: 'a06-capture-confirm-0001',
      studentId,
      version: candidate.version,
      visibility: 'parent_shareable',
    };

    const confirmed = await request(app)
      .post(`/api/v1/captures/${captureId}/candidates/${candidate.id}/confirm-record`)
      .set('Cookie', cookie)
      .send(confirmBody);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data).toMatchObject({ studentId, visibility: 'parent_shareable', replayed: false });
    const recordId = confirmed.body.data.recordId as string;

    const confirmationReplay = await request(app)
      .post(`/api/v1/captures/${captureId}/candidates/${candidate.id}/confirm-record`)
      .set('Cookie', cookie)
      .send(confirmBody);
    expect(confirmationReplay.status).toBe(200);
    expect(confirmationReplay.body.data).toMatchObject({ recordId, visibility: 'parent_shareable', replayed: true });
    expect(await prisma.studentRecord.count({ where: { teacherId, studentId } })).toBe(1);
    expect(await prisma.studentRecord.findUniqueOrThrow({ where: { id: recordId } }))
      .toMatchObject({ reviewStatus: 'confirmed', visibility: 'parent_shareable' });

    // 新 PrismaClient + 新 createApp 模拟服务重启；认证 cookie 来自持久 session，不依赖原 app 内存。
    const restartedPrisma = new PrismaClient();
    try {
      const restartedApp = createTestApp(restartedPrisma);
      const restored = await request(restartedApp)
        .get(`/api/v1/captures/${captureId}`)
        .set('Cookie', cookie);
      expect(restored.status).toBe(200);
      expect(restored.body.data.candidate.confirmedRecord).toMatchObject({
        id: recordId,
        studentId,
        reviewStatus: 'confirmed',
        visibility: 'parent_shareable',
        updatedAt: expect.any(String),
      });

      const listed = await request(restartedApp)
        .get('/api/v1/captures')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const listedCapture = listed.body.data.items.find((item: { id: string }) => item.id === captureId);
      expect(listedCapture?.candidate.confirmedRecord).toMatchObject({
        id: recordId,
        studentId,
        reviewStatus: 'confirmed',
        visibility: 'parent_shareable',
        updatedAt: expect.any(String),
      });
    } finally {
      await restartedPrisma.$disconnect();
    }

    const generated = await request(app)
      .post('/api/v1/feedback/draft-tasks')
      .set('Cookie', cookie)
      .send({ clientRequestId: 'a06-capture-generate-0001', studentId, recordIds: [recordId], focus: 'highlight' });
    expect(generated.status).toBe(201);
    expect(generated.body.data.task.error).toBeNull();
    expect(generated.body.data.task.status).toBe('succeeded');
    expect(generated.body.data.task.generation.evidence.map((item: { id: string }) => item.id)).toEqual([recordId]);
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(0);

    const saveBody = {
      studentId,
      title: generated.body.data.task.draft.title,
      content: generated.body.data.task.draft.content,
      channel: 'manual-copy',
      clientRequestId: 'a06-capture-feedback-save-0001',
      generationTaskId: generated.body.data.task.id,
    };
    const saved = await request(app).post('/api/v1/feedback').set('Cookie', cookie).send(saveBody);
    expect(saved.status).toBe(201);
    const feedbackId = saved.body.data.id as string;
    const savedReplay = await request(app).post('/api/v1/feedback').set('Cookie', cookie).send(saveBody);
    expect(savedReplay.status).toBe(201);
    expect(savedReplay.body.data).toMatchObject({ id: feedbackId, replayed: true });
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(1);

    const snapshot = await request(app)
      .get(`/api/v1/feedback/${feedbackId}/snapshot`)
      .set('Cookie', cookie);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.evidence).toEqual([
      expect.objectContaining({ id: recordId, summary: expect.stringContaining('主动检查') }),
    ]);

    // 记录由服务端变更后，重新装配的 HTTP 上下文必须立刻反映正式状态，且停止作为家长反馈依据。
    const serverUpdated = await prisma.studentRecord.update({
      where: { id: recordId },
      data: { reviewStatus: 'superseded', visibility: 'internal_only' },
    });
    const stateChangedPrisma = new PrismaClient();
    try {
      const stateChangedApp = createTestApp(stateChangedPrisma);
      const stateChanged = await request(stateChangedApp)
        .get(`/api/v1/captures/${captureId}`)
        .set('Cookie', cookie);
      expect(stateChanged.status).toBe(200);
      expect(stateChanged.body.data.candidate.confirmedRecord).toMatchObject({
        id: recordId,
        studentId,
        reviewStatus: 'superseded',
        visibility: 'internal_only',
        updatedAt: serverUpdated.updatedAtTs.toISOString(),
      });

      const stateChangedList = await request(stateChangedApp)
        .get('/api/v1/captures')
        .set('Cookie', cookie);
      expect(stateChangedList.status).toBe(200);
      const stateChangedListedCapture = stateChangedList.body.data.items.find((item: { id: string }) => item.id === captureId);
      expect(stateChangedListedCapture?.candidate.confirmedRecord).toMatchObject({
        id: recordId,
        studentId,
        reviewStatus: 'superseded',
        visibility: 'internal_only',
        updatedAt: serverUpdated.updatedAtTs.toISOString(),
      });

      const blocked = await request(stateChangedApp)
        .post('/api/v1/feedback/draft-tasks')
        .set('Cookie', cookie)
        .send({ clientRequestId: 'a06-capture-blocked-0001', studentId, recordIds: [recordId], focus: 'highlight' });
      expect(blocked.status).toBe(201);
      expect(blocked.body.data.task).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    } finally {
      await stateChangedPrisma.$disconnect();
    }

    // 即使记录恢复为可分享状态，损坏的 capture source 绑定也不能被投影为已确认正式记录。
    await prisma.studentRecord.update({
      where: { id: recordId },
      data: {
        reviewStatus: 'confirmed',
        visibility: 'parent_shareable',
        structuredData: encryptJsonFieldValue(cipher, {
          captureEventId: captureId,
          captureCandidateId: 'mismatched-candidate',
        }) as Prisma.InputJsonValue,
      },
    });
    const corruptedSourcePrisma = new PrismaClient();
    try {
      const corruptedSourceApp = createTestApp(corruptedSourcePrisma);
      const corruptedSource = await request(corruptedSourceApp)
        .get(`/api/v1/captures/${captureId}`)
        .set('Cookie', cookie);
      expect(corruptedSource.status).toBe(200);
      expect(corruptedSource.body.data.candidate.confirmedRecord).toBeNull();
    } finally {
      await corruptedSourcePrisma.$disconnect();
    }
  });
});
