import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createActionTokenSigner, createPendingActionService } from '../../src/features/pending-action/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createLessonService } from '../../src/features/lessons/index.js';
import { createStudentService } from '../../src/features/students/index.js';
import { createFeedbackService } from '../../src/features/feedback/index.js';
import { createConfirmationGateway, createConfirmationTransactionPort } from '../../src/app/confirmation/index.js';
import type { EditConfirmationOwnerPorts } from '../../src/app/confirmation/index.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/index.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

// P29-W1 端到端：Agent 调用 feedback.updateStatus 只能产生 PendingAction，
// confirm 之后才变更状态并写唯一一条 agent-confirmed ChangeLog；actionToken 永不进对话 turns。

const TEACHER = 'test-feedback-status-confirmation-teacher';
const SECRET = 'test-feedback-status-secret-with-at-least-32-bytes';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createFeedback(status: 'draft' | 'reviewed' | 'sent' = 'reviewed') {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER, name: '反馈学生', grade: '高一', source: 'test' },
  });
  const service = createFeedbackService({ prisma, cipher });
  const created = await service.createFeedback({
    teacherId: TEACHER,
    studentId: student.id,
    title: '待确认反馈',
    content: '本周学习状态稳定',
    channel: 'wechat',
    parentName: '家长',
  });
  if (!created.ok) throw new Error(`fixture createFeedback failed: ${created.error.message}`);
  if (status !== 'draft') {
    await prisma.parentFeedback.update({ where: { id: created.value.id }, data: { status } });
  }
  return prisma.parentFeedback.findUniqueOrThrow({ where: { id: created.value.id } });
}

function createRuntime() {
  const conversations = createConversationService({ prisma });
  const signer = createActionTokenSigner({ secret: SECRET });
  const pendingActions = createPendingActionService({
    prisma,
    actionTokenSigner: signer,
    conversationOwner: {
      getOwnedConversation: (input) => conversations.getConversation(input),
    },
    cipher,
  });
  const feedbackService = createFeedbackService({ prisma, cipher });
  const gateway = createConfirmationGateway({
    pendingActions,
    schedules: createScheduleService(prisma),
    lessons: createLessonService(prisma),
    students: createStudentService(prisma),
    editOwners: {
      feedback: {
        getOwnedFeedback: (input) => feedbackService.getFeedback(input),
      },
    } as unknown as EditConfirmationOwnerPorts, // 本切片只使用 feedback owner
  });
  const confirm = createConfirmPendingActionUseCase({
    actionTokenSigner: signer,
    transaction: createConfirmationTransactionPort({ rawPrisma: prisma }),
  });
  return { conversations, pendingActions, gateway, confirm };
}

async function runTool(toolCall: ToolCall) {
  const runtime = createRuntime();
  const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
  if (!conversation.ok) throw new Error(conversation.error.message);
  let chatCount = 0;
  const aiClient: AiClient = {
    run: vi.fn(async () => ({ ok: true, value: {} })),
    chat: vi.fn(async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => {
      chatCount += 1;
      return chatCount === 1
        ? { ok: true as const, value: { content: '准备更新反馈状态', toolCalls: [toolCall] } }
        : { ok: true as const, value: { content: '不应调用第二次模型' } };
    }),
  };
  const result = await createAgentConverseUseCase({
    conversationService: runtime.conversations,
    aiClient,
    toolRegistry: createMinimalToolRegistry({ prisma }),
    confirmationGateway: runtime.gateway,
  }).execute({
    teacherId: TEACHER,
    conversationId: conversation.value.id,
    message: '请把反馈标记为已发送',
  });
  const pending = await prisma.pendingAction.findUniqueOrThrow({
    where: { teacherId_toolCallId: { teacherId: TEACHER, toolCallId: toolCall.id } },
  });
  const turns = await prisma.conversationTurn.findMany({
    where: { conversationId: conversation.value.id },
    orderBy: { createdAtTs: 'asc' },
  });
  return { ...runtime, conversation, result, pending, turns, aiClient };
}

async function confirmPending(runtime: Awaited<ReturnType<typeof runTool>>) {
  const queried = await runtime.pendingActions.getPendingAction({
    teacherId: TEACHER,
    pendingActionId: runtime.pending.id,
  });
  if (!queried.ok) throw new Error(queried.error.message);
  return runtime.confirm.confirm({
    teacherId: TEACHER,
    pendingActionId: runtime.pending.id,
    actionToken: queried.value.actionToken,
  });
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.changeLog.deleteMany();
  await prisma.pendingAction.deleteMany();
  await prisma.conversationTurn.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.parentFeedback.deleteMany();
  await prisma.lesson.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.student.deleteMany();
});

describe('Agent feedback.updateStatus 可信确认 workflow（P29-W1）', () => {
  it('Agent 调用后只产生 PendingAction：状态不变、ChangeLog 0、actionToken 不进对话 turns', async () => {
    const feedback = await createFeedback('reviewed');
    const runtime = await runTool({
      id: 'call-feedback-status-1',
      name: 'feedback.updateStatus',
      args: { feedbackId: feedback.id, status: 'sent' },
    });

    expect(runtime.result.ok).toBe(true);
    if (!runtime.result.ok) return;
    expect(runtime.result.value.reply).toBe('操作待确认，请在确认卡中核对后继续。');
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    // 只统计确认切片的显式审计（source: agent-confirmed）；fixture 的 create 审计（system）不属于本切片
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    })).toBe(0);
    expect(runtime.pending.actionName).toBe('feedback.updateStatus');
    expect(runtime.pending.targetType).toBe('ParentFeedback');
    expect(runtime.pending.targetId).toBe(feedback.id);
    expect(cipher.decryptJson<Record<string, unknown>>(runtime.pending.parameters as unknown as string)).toEqual({
      feedbackId: feedback.id,
      status: 'sent',
      expectedUpdatedAt: feedback.updatedAtTs.toISOString(),
    });

    const queried = await runtime.pendingActions.getPendingAction({
      teacherId: TEACHER,
      pendingActionId: runtime.pending.id,
    });
    if (!queried.ok) throw new Error(queried.error.message);
    const serialized = JSON.stringify({ result: runtime.result, turns: runtime.turns });
    expect(serialized).not.toContain(queried.value.actionToken);
    expect(serialized).not.toContain('actionToken');
  });

  it('confirm 之后才变更状态并写恰好一条 ChangeLog(source:agent-confirmed)', async () => {
    const feedback = await createFeedback('reviewed');
    const runtime = await runTool({
      id: 'call-feedback-status-2',
      name: 'feedback.updateStatus',
      args: { feedbackId: feedback.id, status: 'sent', sentAt: '2031-02-03T12:05:06.123456789+08:00' },
    });

    const confirmed = await confirmPending(runtime);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.pendingAction.status).toBe('consumed');
    const persisted = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
    expect(persisted.status).toBe('sent');
    expect(persisted.sentAtTs).toEqual(new Date('2031-02-03T04:05:06.123Z'));
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('agent-confirmed');
  });

  it('相同 teacherId + toolCallId 重放只保留一个 PendingAction', async () => {
    const feedback = await createFeedback('reviewed');
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const input = {
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-feedback-idempotent',
      toolName: 'feedback.updateStatus',
      args: { feedbackId: feedback.id, status: 'sent' },
    };

    const first = await runtime.gateway.requestConfirmation(input);
    const second = await runtime.gateway.requestConfirmation(input);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await prisma.pendingAction.count()).toBe(1);
  });

  it('恶意附加字段（confirm/actionToken/嵌套 parameters）在 Gateway 全部拒绝，零状态写入', async () => {
    const feedback = await createFeedback('reviewed');
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);

    const result = await runtime.gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-feedback-malicious',
      toolName: 'feedback.updateStatus',
      args: {
        feedbackId: feedback.id,
        status: 'sent',
        confirm: true,
        actionToken: 'malicious-token',
        parameters: { status: 'archived' },
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
    expect(await prisma.pendingAction.count()).toBe(0);
    expect((await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } })).status).toBe('reviewed');
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, targetId: feedback.id, source: 'agent-confirmed' },
    })).toBe(0);
  });
});
