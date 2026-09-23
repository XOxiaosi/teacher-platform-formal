import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../src/features/conversation/conversation-service.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import type { ToolRegistry } from '../../src/shared/tool-registry/types.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

// Phase 4.2-A: 红灯测试
// 锁定 Agent 可通过低风险写工具创建学生、日程、缴费。
// 当前实现未注册这些工具，因此应红灯失败，失败原因集中为工具未注册。

let createMinimalToolRegistry: unknown;
try {
  const mod = await import('../../src/app/tool-registration.js');
  createMinimalToolRegistry = mod.createMinimalToolRegistry;
} catch {
  // 模块不存在
}

function requireRegistryFactory() {
  if (!createMinimalToolRegistry) {
    throw new Error('createMinimalToolRegistry export is missing');
  }
  return createMinimalToolRegistry as (options: {
    prisma: PrismaClient;
    trustedClock?: {
      now(): Promise<Result<Date, CommonError>>;
    };
  }) => ToolRegistry;
}

function createMockAiClient(chatFn: (messages: ChatMessage[], tools: ChatToolDefinition[]) => Promise<Result<{ content: string; toolCalls?: ToolCall[] }, CommonError>>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(chatFn),
  };
}

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-p0-write-workflow';

async function cleanup() {
  const teacherIds = [TEACHER_ID];
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payment.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

async function createConversationFixture() {
  const conversationService = createConversationService({ prisma });
  const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
  if (!convResult.ok) throw new Error('创建 conversation 失败');
  return { conversationService, conversationId: convResult.value.id };
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('Agent P0 低风险写工具 workflow（Phase 4.2-A 红灯）', () => {
  it('registry.list 暴露低风险写工具，不暴露未设计的回溯修正工具', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('students.create');
    expect(toolNames).toContain('scheduling.create');
    expect(toolNames).toContain('payments.create');
    expect(toolNames).not.toContain('scheduling.update');
    expect(toolNames).not.toContain('lessons.update');
  });

  it('Agent 通过 students.create 创建学生', async () => {
    const toolRegistry = requireRegistryFactory()({ prisma });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来创建学生',
            toolCalls: [{
              id: 'call-students-create',
              name: 'students.create',
              args: { name: '新学生', grade: '高一', source: 'agent', stageGoal: '夯实力学' },
            }],
          },
        };
      }
      return { ok: true, value: { content: '已创建新学生' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '新增一个学生' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`agent converse failed: ${result.error.code}`);
    const students = await prisma.student.findMany({ where: { teacherId: TEACHER_ID } });
    expect(students).toHaveLength(1);
    expect(students[0].name).toBe('新学生');
    expect(students[0].grade).toBe('高一');
    expect(students[0].stageGoal).toBe('夯实力学');
  });

  it('Agent 通过旧 scheduling.create 只创建非课程日程', async () => {
    const student = await createStudentFixture(TEACHER_ID, '日程学生');
    const toolRegistry = requireRegistryFactory()({
      prisma,
      trustedClock: {
        now: async () => ({ ok: true, value: new Date('2026-07-19T00:00:00.000Z') }),
      },
    });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来创建备课安排',
            toolCalls: [{
              id: 'call-scheduling-create',
              name: 'scheduling.create',
              args: {
                studentId: student.id,
                type: 'prep',
                title: '物理备课',
                scheduledStart: '2026-07-20T10:00:00.000Z',
                scheduledEnd: '2026-07-20T11:30:00.000Z',
                confidence: 'high',
              },
            }],
          },
        };
      }
      return { ok: true, value: { content: '已创建日程' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '新增一个备课安排' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`agent converse failed: ${result.error.code}`);
    const schedules = await prisma.schedule.findMany({ where: { teacherId: TEACHER_ID } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].studentId).toBe(student.id);
    expect(schedules[0].title).toBe('物理备课');
    expect(schedules[0].type).toBe('prep');
  });

  it('Agent 通过 payments.create 无 gateway 时 fail-closed（P29-W1：确认前置，不直接创建）', async () => {
    const student = await createStudentFixture(TEACHER_ID, '缴费学生');
    const toolRegistry = requireRegistryFactory()({ prisma });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来创建缴费',
            toolCalls: [{
              id: 'call-payments-create',
              name: 'payments.create',
              args: {
                studentId: student.id,
                amount: 1200,
                lessonCount: 10,
                paidAt: '2026-07-21T12:00:00.000Z',
                note: '暑期课包',
              },
            }],
          },
        };
      }
      return { ok: true, value: { content: '不应调用第二次模型' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '新增缴费' });

    // P29-W1：payments.create 已声明 confirmation:required；无 ConfirmationGateway 时
    // Agent 主循环不执行 handler（不直接创建 Payment）。完整确认流程由
    // tests/e2e/agent-payments-create-confirmation-workflow.test.ts 覆盖。
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('payments.create unexpectedly executed without gateway');
    expect(result.error?.code).toBe('INTERNAL_ERROR');
    expect(await prisma.payment.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });
});
