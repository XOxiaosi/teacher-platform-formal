import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createActionTokenSigner, createPendingActionService } from '../../src/features/pending-action/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createLessonService } from '../../src/features/lessons/index.js';
import { createStudentService } from '../../src/features/students/index.js';
import { createConfirmationGateway, createConfirmationTransactionPort } from '../../src/app/confirmation/index.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/index.js';
import {
  COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE,
  LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE,
} from '../../src/app/policies/completion-entrypoint-gate.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批5：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

const TEACHER = 'test-state-gateway-teacher';
const SECRET = 'test-state-gateway-secret-with-at-least-32-bytes';

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent(name = '状态学生') {
  return prisma.student.create({ data: { teacherId: TEACHER, name, grade: '高一' } });
}

async function createSchedule(status = 'planned') {
  return prisma.schedule.create({
    data: {
      teacherId: TEACHER,
      type: 'lesson',
      title: '可信确认日程',
      scheduledStartTs: new Date('2030-01-01T08:00:00.000Z'),
      scheduledEndTs: new Date('2030-01-01T09:00:00.000Z'),
      status,
    },
  });
}

async function createLesson() {
  const student = await createStudent('课次学生');
  const schedule = await createSchedule('completed');
  return prisma.lesson.create({
    data: {
      teacherId: TEACHER,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: new Date('2030-01-01T08:00:00.000Z'),
    },
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
  });
  const gateway = createConfirmationGateway({
    pendingActions,
    schedules: createScheduleService(prisma),
    lessons: createLessonService(prisma),
    students: createStudentService(prisma),
    editOwners: {} as never,
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
        ? { ok: true as const, value: { content: '准备创建待确认操作', toolCalls: [toolCall] } }
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
    message: '请执行状态更新',
  });
  const pending = await prisma.pendingAction.findUniqueOrThrow({
    where: { teacherId_toolCallId: { teacherId: TEACHER, toolCallId: toolCall.id } },
  });
  const turns = await prisma.conversationTurn.findMany({
    where: { conversationId: conversation.value.id },
    orderBy: { createdAtTs: 'asc' },
  });
  return { ...runtime, result, pending, turns, aiClient };
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
  await prisma.scheduleCompletionSnapshot.deleteMany();
  await prisma.lessonLedgerEntry.deleteMany();
  await prisma.lesson.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.student.deleteMany();
});

describe('Agent P0 state tools trusted confirmation workflow', () => {
  it('仅两个仍可确认的状态工具对模型可见；禁用动作不出现在 registry/list', async () => {
    const registry = createMinimalToolRegistry({ prisma });
    const stateToolNames = new Set([
      'scheduling.cancel',
      'students.updateStatus',
    ]);
    const definitions = registry.list().filter((tool) => stateToolNames.has(tool.name));

    expect(definitions.map((tool) => tool.name).sort()).toEqual([
      'scheduling.cancel',
      'students.updateStatus',
    ]);
    expect(registry.list().some((tool) => tool.name === 'scheduling.complete')).toBe(false);
    expect(registry.list().some((tool) => tool.name === 'lessons.updateStatus')).toBe(false);
    for (const definition of definitions) {
      expect(definition.sideEffect).toBe('update');
      expect(JSON.stringify(definition.parameters)).not.toContain('confirm');
      const direct = await registry.execute(definition.name, {}, { teacherId: TEACHER });
      expect(direct).toEqual({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '该工具必须通过 ConfirmationGateway 创建待确认操作',
          field: 'confirmation',
        },
      });
    }
  });

  it('scheduling.complete 不创建 PendingAction，不允许 AI 绕过完课预览', async () => {
    const schedule = await createSchedule();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);

    const result = await runtime.gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-schedule-complete',
      toolName: 'scheduling.complete',
      args: { scheduleId: schedule.id },
    });

    expect(result).toEqual({ ok: false, error: {
      code: 'VALIDATION_ERROR', message: COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, field: 'completion',
    } });
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).status).toBe('planned');
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('scheduling.cancel 先 pending，确认后才取消', async () => {
    const schedule = await createSchedule();
    const runtime = await runTool({
      id: 'call-schedule-cancel',
      name: 'scheduling.cancel',
      args: { scheduleId: schedule.id },
    });

    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).status).toBe('planned');
    expect((await confirmPending(runtime)).ok).toBe(true);
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).status).toBe('cancelled');
  });

  it('lessons.updateStatus 不创建 PendingAction，避免绕过出勤状态更正确认', async () => {
    const lesson = await createLesson();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);

    const result = await runtime.gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-lesson-status',
      toolName: 'lessons.updateStatus',
      args: { lessonId: lesson.id, status: 'attended' },
    });

    expect(result).toEqual({ ok: false, error: {
      code: 'VALIDATION_ERROR', message: LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE, field: 'lessonStatus',
    } });
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).status).toBe('pending');
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it.each([
    ['scheduling.complete', 'Schedule', COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, 'completion', (id: string) => ({ scheduleId: id })],
    ['lessons.updateStatus', 'Lesson', LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE, 'lessonStatus', (id: string) => ({ lessonId: id, status: 'attended' })],
  ] as const)('%s 的旧 pending 确认回滚 claim，且不产生完课或账本写入', async (actionName, targetType, message, field, parameters) => {
    const target = targetType === 'Schedule' ? await createSchedule() : await createLesson();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const created = await runtime.pendingActions.createPendingAction({
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: `legacy-${actionName}`,
      actionName,
      target: { type: targetType, id: target.id },
      parameters: parameters(target.id),
      beforeSummary: '历史待确认操作',
      afterSummary: '历史状态写入',
    });
    if (!created.ok) throw new Error(created.error.message);

    const result = await runtime.confirm.confirm({
      teacherId: TEACHER,
      pendingActionId: created.value.pendingAction.id,
      actionToken: created.value.actionToken,
    });

    expect(result).toEqual({ ok: false, error: {
      code: 'VALIDATION_ERROR', message, field,
    } });
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: created.value.pendingAction.id } })).status).toBe('pending');
    expect(await prisma.changeLog.count()).toBe(0);
    expect(await prisma.lessonLedgerEntry.count()).toBe(0);
    expect(await prisma.scheduleCompletionSnapshot.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    if (targetType === 'Schedule') {
      expect((await prisma.schedule.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('planned');
      expect(await prisma.lesson.count()).toBe(0);
    } else {
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('pending');
    }
  });

  it('students.updateStatus 丢弃恶意附加字段，pending 与 turns 均不泄露 token', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-student-status',
      name: 'students.updateStatus',
      args: {
        studentId: student.id,
        status: 'paused',
        confirm: true,
        actionToken: 'malicious-token',
        parameters: { status: 'finished' },
      },
    });

    expect(runtime.result).toEqual({
      ok: true,
      value: {
        conversationId: runtime.pending.conversationId,
        reply: '操作待确认，请在确认卡中核对后继续。',
      },
    });
    // P8 phase-3 批5：parameters 落库为密文，解密后断言
    expect(cipher.decryptJson<unknown>(runtime.pending.parameters as unknown as string)).toEqual({ studentId: student.id, status: 'paused' });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
    expect(runtime.aiClient.chat).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify({ result: runtime.result, turns: runtime.turns });
    expect(serialized).not.toContain('malicious-token');
    expect(serialized).not.toContain('actionToken');
    expect((await confirmPending(runtime)).ok).toBe(true);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('paused');
    expect(await prisma.changeLog.count({ where: { targetId: student.id } })).toBe(1);
  });

  it('相同 teacherId + toolCallId 重放只保留一个 PendingAction', async () => {
    const student = await createStudent();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const input = {
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-idempotent',
      toolName: 'students.updateStatus',
      args: { studentId: student.id, status: 'paused' },
    };

    const first = await runtime.gateway.requestConfirmation(input);
    const second = await runtime.gateway.requestConfirmation(input);

    expect(first).toEqual(second);
    expect(await prisma.pendingAction.count()).toBe(1);
  });
});
