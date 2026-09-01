import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createActionTokenSigner, createPendingActionService } from '../../src/features/pending-action/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createLessonService } from '../../src/features/lessons/index.js';
import { createStudentService } from '../../src/features/students/index.js';
import {
  createConfirmationGateway,
  createConfirmationTransactionPort,
} from '../../src/app/confirmation/index.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/index.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

// P29-W1（第三最小切片）端到端：Agent 调用 students.records.capture 只能产生 PendingAction，
// confirm 之后才在同一事务内重查学生归属 + 版本 CAS、创建 StudentRecord 并写唯一一条
// agent-confirmed 审计、消费 PendingAction；任一步失败整体回滚。actionToken 永不进对话 turns。
//
// TDD 红灯：实现缺失时工具直接执行（创建记录）且 gateway 对 students.records.capture
// 返回 VALIDATION_ERROR（工具不支持可信确认），无 PendingAction；本文件契约断言全部红灯，
// 直到实现落盘。

const TEACHER = 'test-records-confirmation-teacher';
const SECRET = 'test-records-create-secret-with-at-least-32-bytes';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent() {
  return prisma.student.create({
    data: { teacherId: TEACHER, name: '记录学生', grade: '高一', source: 'test' },
  });
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
  const gateway = createConfirmationGateway({
    pendingActions,
    schedules: createScheduleService(prisma),
    lessons: createLessonService(prisma),
    students: createStudentService(prisma),
    editOwners: {},
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
        ? { ok: true as const, value: { content: '准备为学生创建记录', toolCalls: [toolCall] } }
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
    message: '请为学生创建一条学习记录',
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
  await prisma.studentRecord.deleteMany();
  await prisma.studentSourceRecord.deleteMany();
  await prisma.student.deleteMany();
});

describe('Agent students.records.capture 可信确认 workflow（P29-W1）', () => {
  it('Agent 调用后只产生 PendingAction：不创建 StudentRecord、无审计、actionToken 不进对话 turns', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-records-capture-1',
      name: 'students.records.capture',
      args: {
        studentId: student.id,
        category: 'learning_state',
        summary: '本周学习状态稳定',
      },
    });

    expect(runtime.result.ok).toBe(true);
    if (!runtime.result.ok) return;
    expect(runtime.result.value.reply).toBe('操作待确认，请在确认卡中核对后继续。');
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
    expect(runtime.pending.actionName).toBe('students.records.capture');
    expect(runtime.pending.targetType).toBe('Student');
    expect(runtime.pending.targetId).toBe(student.id);
    expect(cipher.decryptJson<Record<string, unknown>>(runtime.pending.parameters as unknown as string)).toEqual({
      studentId: student.id,
      category: 'learning_state',
      summary: '本周学习状态稳定',
      expectedUpdatedAt: student.updatedAtTs.toISOString(),
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

  it('confirm 之后才创建 StudentRecord 并写恰好一条 ChangeLog(source:agent-confirmed)，PendingAction 消费', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-records-capture-2',
      name: 'students.records.capture',
      args: {
        studentId: student.id,
        category: 'learning_state',
        summary: '本周学习状态稳定',
      },
    });

    const confirmed = await confirmPending(runtime);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.pendingAction.status).toBe('consumed');
    expect(confirmed.value.result.references).toEqual([{ type: 'StudentRecord', id: expect.any(String) }]);
    const records = await prisma.studentRecord.findMany({ where: { teacherId: TEACHER } });
    expect(records).toHaveLength(1);
    expect(records[0].studentId).toBe(student.id);
    expect(records[0].category).toBe('learning_state');
    expect(records[0].reviewStatus).toBe('candidate');
    expect(cipher.decrypt(records[0].summary)).toBe('本周学习状态稳定');
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: records[0].id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('student-records');
    expect(logs[0].targetType).toBe('StudentRecord');
  });

  it('相同 teacherId + toolCallId 重放只保留一个 PendingAction', async () => {
    const student = await createStudent();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const input = {
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-records-idempotent',
      toolName: 'students.records.capture',
      args: { studentId: student.id, category: 'learning_state', summary: '本周学习状态稳定' },
    };

    const first = await runtime.gateway.requestConfirmation(input);
    const second = await runtime.gateway.requestConfirmation(input);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await prisma.pendingAction.count()).toBe(1);
  });

  it('恶意附加字段（confirm/actionToken/嵌套 parameters）在 Gateway 全部拒绝，零写入', async () => {
    const student = await createStudent();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);

    const result = await runtime.gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-records-malicious',
      toolName: 'students.records.capture',
      args: {
        studentId: student.id,
        category: 'learning_state',
        summary: '本周学习状态稳定',
        confirm: true,
        actionToken: 'malicious-token',
        parameters: { category: 'goal' },
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
    expect(await prisma.pendingAction.count()).toBe(0);
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
  });
});
