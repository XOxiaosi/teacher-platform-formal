import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import {
  createActionTokenSigner,
  createPendingActionService,
  CONFIRMABLE_ACTION_NAMES,
} from '../../src/features/pending-action/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createScheduleService } from '../../src/features/scheduling/index.js';
import { createLessonService } from '../../src/features/lessons/index.js';
import { createStudentService } from '../../src/features/students/index.js';
import {
  createConfirmationGateway,
  createConfirmationTransactionPort,
  createConfirmableActionRegistry,
  createDatabaseConfirmableActionRegistry,
  type ConfirmableActionExecutor,
  type ConfirmableActionExecutorMap,
} from '../../src/app/confirmation/index.js';
import { createConfirmPendingActionUseCase } from '../../src/app/use-cases/confirm-pending-action/index.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';
import { createMinimalToolRegistry } from '../../src/app/tool-registration.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

// P29-W1（第二最小切片）端到端：Agent 调用 payments.create 只能产生 PendingAction，
// confirm 之后才在同一事务内重查学生归属 + 版本 CAS、创建 Payment 并写唯一一条
// agent-confirmed 审计、消费 PendingAction；任一步失败整体回滚。actionToken 永不进对话 turns。
//
// TDD 红灯：实现缺失时 gateway 对 payments.create 返回 VALIDATION_ERROR（工具不支持可信确认），
// agent 调用失败、无 PendingAction；本文件契约断言全部红灯，直到实现落盘。

const TEACHER = 'test-payment-create-confirmation-teacher';
const OTHER_TEACHER = 'test-payment-create-confirmation-other';
const SECRET = 'test-payment-create-secret-with-at-least-32-bytes';
const cipher = createFieldCipher(loadEncryptionKey().key);

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function createStudent() {
  return prisma.student.create({
    data: { teacherId: TEACHER, name: '缴费学生', grade: '高一', source: 'test' },
  });
}

function createRuntime(options?: {
  registryFactory?: (tx: Prisma.TransactionClient) => ReturnType<typeof createConfirmableActionRegistry>;
}) {
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
    transaction: createConfirmationTransactionPort({
      rawPrisma: prisma,
      registryFactory: options?.registryFactory,
    }),
  });
  return { conversations, pendingActions, gateway, confirm };
}

async function runTool(toolCall: ToolCall, options?: {
  registryFactory?: (tx: Prisma.TransactionClient) => ReturnType<typeof createConfirmableActionRegistry>;
}) {
  const runtime = createRuntime(options);
  const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
  if (!conversation.ok) throw new Error(conversation.error.message);
  let chatCount = 0;
  const aiClient: AiClient = {
    run: vi.fn(async () => ({ ok: true, value: {} })),
    chat: vi.fn(async (_messages: ChatMessage[], _tools: ChatToolDefinition[]) => {
      chatCount += 1;
      return chatCount === 1
        ? { ok: true as const, value: { content: '准备创建缴费记录', toolCalls: [toolCall] } }
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
    message: '请为学生创建缴费记录',
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

async function confirmPending(runtime: Awaited<ReturnType<typeof runTool>>, teacherId = TEACHER) {
  // actionToken 由 PendingAction 持有者（TEACHER）签名签发；跨 teacher confirm 用同一 token
  // 验证 claim 阶段的归属拒绝（此时不得报“token 不匹配”，而是 NOT_FOUND）。
  const queried = await runtime.pendingActions.getPendingAction({
    teacherId: TEACHER,
    pendingActionId: runtime.pending.id,
  });
  if (!queried.ok) throw new Error(queried.error.message);
  return runtime.confirm.confirm({
    teacherId,
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
  await prisma.payment.deleteMany();
  await prisma.lesson.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.student.deleteMany();
});

describe('Agent payments.create 可信确认 workflow（P29-W1）', () => {
  it('Agent 调用后只产生 PendingAction：不创建 Payment、无审计、actionToken 不进对话 turns', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-payment-create-1',
      name: 'payments.create',
      args: {
        studentId: student.id,
        amount: 1200,
        lessonCount: 10,
        paidAt: '2026-07-21T12:00:00.000Z',
        note: '暑期课包',
      },
    });

    expect(runtime.result.ok).toBe(true);
    if (!runtime.result.ok) return;
    expect(runtime.result.value.reply).toBe('操作待确认，请在确认卡中核对后继续。');
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
    expect(runtime.pending.actionName).toBe('payments.create');
    expect(runtime.pending.targetType).toBe('Student');
    expect(runtime.pending.targetId).toBe(student.id);
    expect(cipher.decryptJson<Record<string, unknown>>(runtime.pending.parameters as unknown as string)).toEqual({
      studentId: student.id,
      amount: 1200,
      lessonCount: 10,
      paidAt: '2026-07-21T12:00:00.000Z',
      note: '暑期课包',
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

  it('confirm 之后才创建 Payment 并写恰好一条 ChangeLog(source:agent-confirmed)，PendingAction 消费', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-payment-create-2',
      name: 'payments.create',
      args: {
        studentId: student.id,
        amount: 1200,
        lessonCount: 10,
        paidAt: '2026-07-21T12:00:00.000Z',
        note: '暑期课包',
      },
    });

    const confirmed = await confirmPending(runtime);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.pendingAction.status).toBe('consumed');
    expect(confirmed.value.result.references).toEqual([{ type: 'Payment', id: expect.any(String) }]);
    const payments = await prisma.payment.findMany({ where: { teacherId: TEACHER } });
    expect(payments).toHaveLength(1);
    expect(payments[0].studentId).toBe(student.id);
    expect(payments[0].amount).toBe(1200);
    expect(payments[0].lessonCount).toBe(10);
    expect(cipher.decrypt(payments[0].note!)).toBe('暑期课包');
    const logs = await prisma.changeLog.findMany({
      where: { teacherId: TEACHER, targetId: payments[0].id, source: 'agent-confirmed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('create');
    expect(logs[0].module).toBe('payments');
    expect(logs[0].targetType).toBe('Payment');
  });

  it('相同 teacherId + toolCallId 重放只保留一个 PendingAction', async () => {
    const student = await createStudent();
    const runtime = createRuntime();
    const conversation = await runtime.conversations.createConversation({ teacherId: TEACHER });
    if (!conversation.ok) throw new Error(conversation.error.message);
    const input = {
      teacherId: TEACHER,
      conversationId: conversation.value.id,
      toolCallId: 'call-payment-idempotent',
      toolName: 'payments.create',
      args: { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
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
      toolCallId: 'call-payment-malicious',
      toolName: 'payments.create',
      args: {
        studentId: student.id,
        amount: 1200,
        lessonCount: 10,
        paidAt: '2026-07-21T12:00:00.000Z',
        confirm: true,
        actionToken: 'malicious-token',
        parameters: { amount: 1 },
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
    expect(await prisma.pendingAction.count()).toBe(0);
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(0);
  });

  it('confirm 时学生版本已前进（CAS 冲突）→ 整体回滚：不创建 Payment、不写审计、PendingAction 保持 pending', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-payment-cas',
      name: 'payments.create',
      args: { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
    });

    // 请求到确认之间学生被并发修改 → 版本 token 前进
    await prisma.student.update({
      where: { id: student.id },
      data: { updatedAtTs: new Date('2031-01-01T00:00:00.000Z') },
    });

    const confirmed = await confirmPending(runtime);
    expect(confirmed).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: runtime.pending.id } })).status).toBe('pending');
  });

  it('跨 teacher confirm 拒绝且零写入，PendingAction 保持 pending', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-payment-cross',
      name: 'payments.create',
      args: { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
    });

    const confirmed = await confirmPending(runtime, OTHER_TEACHER);
    expect(confirmed).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: runtime.pending.id } })).status).toBe('pending');
  });

  it('executor 业务写入后审计失败 → 整体回滚：Payment、审计、claim 全部撤销', async () => {
    const student = await createStudent();
    // 包装真实 payments.create executor：先完整执行（创建 Payment + 审计），再强制返回错误，
    // 验证 ConfirmationTransactionPort 把已发生的业务写入整体回滚。
    const runtime = await runTool({
      id: 'call-payment-audit-fail',
      name: 'payments.create',
      args: { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
    }, {
      registryFactory: (tx) => {
        const inner = createDatabaseConfirmableActionRegistry(tx);
        const map: Record<string, ConfirmableActionExecutor> = {};
        for (const name of CONFIRMABLE_ACTION_NAMES) {
          const got = inner.get(name);
          map[name] = got.ok ? got.value : {
            async execute() {
              return err({ code: 'INTERNAL_ERROR' as const, message: 'executor 未注册' });
            },
          };
        }
        map['payments.create'] = {
          async execute(input) {
            const got = inner.get('payments.create');
            if (!got.ok) return got;
            const executed = await got.value.execute(input);
            if (!executed.ok) return executed;
            return err(validationError('审计失败', 'audit'));
          },
        };
        return createConfirmableActionRegistry(map as ConfirmableActionExecutorMap);
      },
    });

    const confirmed = await confirmPending(runtime);
    expect(confirmed).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'audit' },
    });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect(await prisma.changeLog.count({ where: { teacherId: TEACHER } })).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: runtime.pending.id } })).status).toBe('pending');
  });

  it('重复确认只执行一次：第二次返回 ALREADY_CONSUMED，仍恰好一条审计', async () => {
    const student = await createStudent();
    const runtime = await runTool({
      id: 'call-payment-repeat',
      name: 'payments.create',
      args: { studentId: student.id, amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
    });

    const first = await confirmPending(runtime);
    const second = await confirmPending(runtime);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: 'ALREADY_CONSUMED' } });
    expect(await prisma.payment.count({ where: { teacherId: TEACHER } })).toBe(1);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER, source: 'agent-confirmed' },
    })).toBe(1);
  });
});
