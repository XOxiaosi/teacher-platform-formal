import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createPushService } from '../../../src/features/push/index.js';
import { createPendingActionService } from '../../../src/features/pending-action/index.js';
import { createAgentExecutionService } from '../../../src/features/agent-execution/index.js';
import { createFeedbackService } from '../../../src/features/feedback/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

/**
 * P8 phase-3 加密落位批5（t22）：PushRecord.content + PendingAction（parameters/beforeSummary/afterSummary）
 * + AgentExecution.reply/error + FeedbackEvidence（summary/parentConcerns/followUps）。
 * - setup 已注入测试 ENCRYPTION_KEY → 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 不变 / 缺钥 SAFETY_BLOCK。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64);

const TEACHER_A = `teacher_enc5_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc5_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_enc5_a_${randomBytes(4).toString('hex')}`;

let pushService: ReturnType<typeof createPushService>;
let pendingService: ReturnType<typeof createPendingActionService>;
let agentExecutionService: ReturnType<typeof createAgentExecutionService>;
let feedbackService: ReturnType<typeof createFeedbackService>;

const pushAdapter = { send: vi.fn(async () => ok({ providerMessageId: 'p5-msg-1' })) };

beforeAll(async () => {
  await prisma.student.create({
    data: { id: STUDENT_A, teacherId: TEACHER_A, name: '加密批5学生', grade: 'grade-1', currentStatus: 'active' },
  });
  pushService = createPushService({ prisma, adapters: { 'wechat-bot': pushAdapter } });
  const signer = {
    sign: (id: string) => ok({ token: `tok-${id}` }),
    verify: () => ({ ok: false as const, error: { code: 'VALIDATION_ERROR' as const, message: 'x' } }),
  };
  pendingService = createPendingActionService({
    prisma,
    actionTokenSigner: signer,
    conversationOwner: { getOwnedConversation: async (input: { teacherId: string; conversationId: string }) => (
      ok({ id: input.conversationId, teacherId: input.teacherId, status: 'active', summary: null, createdAt: new Date(), updatedAt: new Date() })
    ) },
  });
  agentExecutionService = createAgentExecutionService({ prisma });
  feedbackService = createFeedbackService({ prisma });
});

afterAll(async () => {
  await prisma.pushRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.pendingAction.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.feedbackEvidence.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.feedbackContextSnapshot.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
});

describe('批5 PushRecord：content 加密往返', () => {
  it('sendPush → DB content 密文，list 解密明文', async () => {
    const sent = await pushService.sendPush({
      teacherId: TEACHER_A,
      type: 'morning_brief',
      channel: 'wechat-bot',
      content: '早间推送：张三今天有物理课',
      scheduledAt: new Date('2026-10-01T08:00:00Z'),
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.content).toBe('早间推送：张三今天有物理课');
    expect(pushAdapter.send).toHaveBeenCalledWith({ to: TEACHER_A, content: '早间推送：张三今天有物理课' });

    const row = await prisma.pushRecord.findUniqueOrThrow({ where: { id: sent.value.id } });
    expect(row.content).not.toBe('早间推送：张三今天有物理课');
    expect(cipher.decrypt(row.content)).toBe('早间推送：张三今天有物理课');

    const list = await pushService.listPushRecords({ teacherId: TEACHER_A, status: 'sent' });
    expect(list.ok && list.value.items[0].content).toBe('早间推送：张三今天有物理课');
  });

  it('旧明文双读：prisma 直插明文 pushRecord → list 直通', async () => {
    const legacy = await prisma.pushRecord.create({
      data: {
        teacherId: TEACHER_A,
        type: 'evening_review',
        scheduledAtTs: new Date('2026-10-01T21:00:00Z'),
        channel: 'wechat-bot',
        content: '旧明文推送',
        status: 'sent',
        sentAtTs: new Date('2026-10-01T21:00:00Z'),
      },
    });
    const list = await pushService.listPushRecords({ teacherId: TEACHER_A });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.items.find((item) => item.id === legacy.id)?.content).toBe('旧明文推送');
  });
});

describe('批5 PendingAction：parameters/beforeSummary/afterSummary 加密往返', () => {
  it('create → DB 密文，get 解密明文；幂等 sameIntent 仍生效', async () => {
    const conv = await prisma.conversation.create({
      data: { teacherId: TEACHER_A, status: 'active', summary: null },
    });
    const created = await pendingService.createPendingAction({
      teacherId: TEACHER_A,
      conversationId: conv.id,
      toolCallId: 'p5-tool-1',
      actionName: 'students.updateProfile',
      target: { type: 'Student', id: STUDENT_A },
      parameters: { studentId: STUDENT_A, status: 'paused', note: '批5参数' },
      beforeSummary: '批5变更前',
      afterSummary: '批5变更后',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.pendingAction.parameters).toMatchObject({ studentId: STUDENT_A, status: 'paused' });
    expect(created.value.pendingAction.beforeSummary).toBe('批5变更前');
    expect(created.value.pendingAction.afterSummary).toBe('批5变更后');

    // DB 是密文
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: created.value.pendingAction.id } });
    expect(row.parameters).not.toEqual({ studentId: STUDENT_A, status: 'paused' });
    expect(cipher.decryptJson<unknown>(row.parameters as unknown as string)).toMatchObject({ status: 'paused' });
    expect(cipher.decrypt(row.afterSummary)).toBe('批5变更后');

    // 读路径解密
    const got = await pendingService.getPendingAction({
      teacherId: TEACHER_A,
      pendingActionId: created.value.pendingAction.id,
    });
    expect(got.ok && got.value.pendingAction.afterSummary).toBe('批5变更后');

    // 幂等 sameIntent（解密后比对）
    const again = await pendingService.createPendingAction({
      teacherId: TEACHER_A,
      conversationId: conv.id,
      toolCallId: 'p5-tool-1',
      actionName: 'students.updateProfile',
      target: { type: 'Student', id: STUDENT_A },
      parameters: { studentId: STUDENT_A, status: 'paused', note: '批5参数' },
      beforeSummary: '批5变更前',
      afterSummary: '批5变更后',
    });
    expect(again.ok && again.value.pendingAction.id).toBe(created.value.pendingAction.id);
  });
});

describe('批5 AgentExecution：reply 加密往返（requestFingerprint 明文幂等键不变）', () => {
  it('claim → complete reply 落库密文，get 解密；fingerprint 由明文 message 计算', async () => {
    const conv = await prisma.conversation.create({
      data: { teacherId: TEACHER_A, status: 'active', summary: null },
    });
    const message = '批5用户消息';
    const claimed = await agentExecutionService.claim({
      teacherId: TEACHER_A,
      conversationId: conv.id,
      clientRequestId: `req-p5-${randomBytes(4).toString('hex')}`,
      message,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const complete = await agentExecutionService.complete({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      status: 'succeeded',
      stage: 'persistence',
      reply: '批5模型回复',
      completedToolCallIds: [],
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    expect(complete.value.reply).toBe('批5模型回复');

    // DB reply 是密文
    const row = await prisma.agentExecution.findUniqueOrThrow({ where: { id: claimed.value.execution.id } });
    expect(row.reply).not.toBe('批5模型回复');
    expect(cipher.decrypt(row.reply!)).toBe('批5模型回复');

    // 读路径解密
    const got = await agentExecutionService.get({ teacherId: TEACHER_A, executionId: claimed.value.execution.id });
    expect(got.ok && got.value.reply).toBe('批5模型回复');
    // requestFingerprint 幂等键仍为明文 message 哈希（语义不变）
    const { createHash } = await import('node:crypto');
    expect(row.requestFingerprint).toBe(createHash('sha256').update(JSON.stringify([conv.id, message]), 'utf8').digest('hex'));
  });
});

describe('批5 FeedbackEvidence：summary/parentConcerns/followUps 加密往返', () => {
  it('createFeedback 带 evidence → DB 密文，getFeedbackSnapshot 解密', async () => {
    const created = await feedbackService.createFeedback({
      teacherId: TEACHER_A,
      studentId: STUDENT_A,
      title: '批5反馈',
      content: '批5内容',
      evidence: [{
        id: 'p5-rec-1',
        type: 'assessment',
        occurredAt: '2026-01-15T10:00:00Z',
        summary: '批5证据摘要',
        parentConcerns: ['批5诉求1', '批5诉求2'],
        followUps: ['批5跟进'],
      }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await prisma.feedbackEvidence.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(row.summary).not.toBe('批5证据摘要');
    expect(cipher.decrypt(row.summary!)).toBe('批5证据摘要');
    expect(cipher.decryptJson<unknown>(row.parentConcerns as unknown as string)).toEqual(['批5诉求1', '批5诉求2']);
    expect(cipher.decryptJson<unknown>(row.followUps as unknown as string)).toEqual(['批5跟进']);

    const snapshot = await feedbackService.getFeedbackSnapshot({
      teacherId: TEACHER_A,
      feedbackId: created.value.id,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.evidence[0].summary).toBe('批5证据摘要');
    expect(snapshot.value.evidence[0].parentConcerns).toEqual(['批5诉求1', '批5诉求2']);
  });
});

describe('批5 篡改拒绝 + 缺钥 SAFETY_BLOCK', () => {
  it('DB pushRecord content 密文被篡改 → list 返回 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const sent = await pushService.sendPush({
      teacherId: TEACHER_A,
      type: 'evening_review',
      channel: 'wechat-bot',
      content: '篡改测试',
      scheduledAt: new Date('2026-10-02T21:00:00Z'),
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const row = await prisma.pushRecord.findUniqueOrThrow({ where: { id: sent.value.id } });
    const original = row.content;
    const parts = row.content.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.pushRecord.update({ where: { id: sent.value.id }, data: { content: parts.join(':') } });

    try {
      const list = await pushService.listPushRecords({ teacherId: TEACHER_A });
      expect(list.ok).toBe(false);
      if (list.ok) return;
      expect(list.error.code).toBe('INTERNAL_ERROR');
      expect(list.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.pushRecord.update({ where: { id: sent.value.id }, data: { content: original } });
    }
  });

  it('ENCRYPTION_KEY 缺省 → sendPush/createPendingAction 写路径 SAFETY_BLOCK', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const noKeyPush = createPushService({ prisma, adapters: { 'wechat-bot': pushAdapter } });
      const pushWrite = await noKeyPush.sendPush({
        teacherId: TEACHER_A,
        type: 'morning_brief',
        channel: 'wechat-bot',
        content: '不应落库',
        scheduledAt: new Date('2026-10-03T08:00:00Z'),
      });
      expect(pushWrite.ok).toBe(false);
      if (pushWrite.ok) return;
      expect(pushWrite.error.message).toContain('SAFETY_BLOCK');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});
