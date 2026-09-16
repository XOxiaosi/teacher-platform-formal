import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createApp } from '../../src/index.js';
import { createCoreRouteDependencies } from '../../src/app/composition/core-route-dependencies.js';
import { createAssembleParentFeedbackContextUseCase } from '../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
import { createGenerateFeedbackDraftUseCase } from '../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js';
import { createFieldCipherFromEnv, encryptFieldValue } from '../../src/shared/field-encryption/index.js';
import type { AiClient, ChatMessage, ChatToolDefinition } from '../../src/shared/ai-client/types.js';
import { acceptInvitation } from '../helpers/invitations.js';

const prisma = new PrismaClient();
const cipher = createFieldCipherFromEnv();
const baseDependencies = createCoreRouteDependencies(prisma, { localSafeMode: true });
const context = createAssembleParentFeedbackContextUseCase({ prisma, cipher });
const generator = createGenerateFeedbackDraftUseCase({
  prisma,
  cipher,
  context,
  aiClient: {
    run: async () => ok({}),
    chat: async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => ok({
      content: '标题：本次课堂的主动验算\n内容：本次课小雨独立完成三道计算题，并主动检查了每一步。接下来继续练习验算。\n所以这样写：用具体课堂行为让家长看见可延续的进展。',
    }),
  } as unknown as AiClient,
});
const app = createApp(prisma, {
  localSafeMode: true,
  coreDependencies: {
    ...baseDependencies,
    feedback: { ...baseDependencies.feedback, generateFeedbackDraft: generator },
  },
});

const teacherIds: string[] = [];
const studentIds: string[] = [];

async function cleanup() {
  if (teacherIds.length === 0) return;
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
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
      .post('/api/v1/feedback/generate-draft')
      .set('Cookie', cookie)
      .send({ studentId, lessonIds: [lesson.id], focus: 'highlight' });
    expect(generated.status).toBe(201);
    expect(generated.body.data).toMatchObject({
      studentId,
      lessonIds: [lesson.id],
      title: '本次课堂的主动验算',
      source: 'ai',
    });
    expect(generated.body.data.evidence.map((item: { id: string }) => item.id)).toEqual([record.id]);
    expect(await prisma.parentFeedback.count({ where: { teacherId, studentId } })).toBe(0);

    const saveBody = {
      studentId,
      lessonId: lesson.id,
      title: generated.body.data.title,
      content: '老师核对后的反馈：小雨主动验算，下一次继续保持。',
      channel: 'manual-copy',
      parentName: '合成家长',
      clientRequestId: 'a06-http-save-0001',
      evidence: generated.body.data.evidence,
      windowStart: generated.body.data.windowStart,
      windowEnd: generated.body.data.windowEnd,
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
});
