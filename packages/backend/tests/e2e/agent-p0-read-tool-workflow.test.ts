import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../src/features/conversation/conversation-service.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import type { ToolRegistry } from '../../src/shared/tool-registry/types.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

// Phase 4.1-A: 红灯测试
// 锁定 Agent 可通过 P0 只读工具读取学生、课次、缴费，并保持 teacherId 隔离。

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
  return createMinimalToolRegistry as (options: { prisma: PrismaClient }) => ToolRegistry;
}

function createMockAiClient(chatFn: (messages: ChatMessage[], tools: ChatToolDefinition[]) => Promise<Result<{ content: string; toolCalls?: ToolCall[] }, CommonError>>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(chatFn),
  };
}

function getChatCalls(aiClient: AiClient): Array<[ChatMessage[], ChatToolDefinition[]]> {
  return (aiClient.chat as unknown as { mock: { calls: Array<[ChatMessage[], ChatToolDefinition[]]> } }).mock.calls;
}

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-p0-read-workflow';

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

async function createLessonFixture(input: { teacherId: string; studentId: string; date: Date; progress: string }) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      type: 'lesson',
      title: 'P0 只读工具测试课次',
      scheduledStartTs: input.date,
      scheduledEndTs: new Date(input.date.getTime() + 90 * 60 * 1000),
      status: 'completed',
    },
  });

  return prisma.lesson.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      scheduleId: schedule.id,
      dateTs: input.date,
      status: 'attended',
      progress: input.progress,
    },
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

describe('Agent P0 只读工具 workflow（Phase 4.1-A 红灯）', () => {
  it('registry.list 暴露 P0 只读工具，不暴露未设计的回溯修正工具', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('students.get');
    expect(toolNames).toContain('students.list');
    expect(toolNames).toContain('scheduling.list');
    expect(toolNames).toContain('lessons.list');
    expect(toolNames).toContain('payments.list');
    expect(toolNames).not.toContain('scheduling.update');
    expect(toolNames).not.toContain('lessons.update');
  });

  it('Agent 通过 students.get 读取当前 teacher 学生详情', async () => {
    const student = await createStudentFixture(TEACHER_ID, '张三');
    const toolRegistry = requireRegistryFactory()({ prisma });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来查询学生详情',
            toolCalls: [{ id: 'call-students-get', name: 'students.get', args: { studentId: student.id } }],
          },
        };
      }
      return { ok: true, value: { content: '张三是高一学生' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '查一下张三' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`agent converse failed: ${result.error.code}`);
    const secondCallMessages = getChatCalls(aiClient)[1][0];
    const toolMessages = secondCallMessages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('张三');
    expect(toolMessages[0].content).toContain(TEACHER_ID);
  });

  it('Agent 通过 lessons.list 读取当前 teacher 课次', async () => {
    const student = await createStudentFixture(TEACHER_ID, '李四');
    await createLessonFixture({ teacherId: TEACHER_ID, studentId: student.id, date: new Date('2026-07-01T10:00:00.000Z'), progress: '我的课次进度' });
    const toolRegistry = requireRegistryFactory()({ prisma });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来查询课次',
            toolCalls: [{ id: 'call-lessons-list', name: 'lessons.list', args: {} }],
          },
        };
      }
      return { ok: true, value: { content: '你有 1 条课次' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '列出课次' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`agent converse failed: ${result.error.code}`);
    const secondCallMessages = getChatCalls(aiClient)[1][0];
    const toolMessages = secondCallMessages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('我的课次进度');
  });

  it('Agent 通过 payments.list 读取当前 teacher 缴费', async () => {
    const student = await createStudentFixture(TEACHER_ID, '王五');
    await prisma.payment.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, amount: 1200, lessonCount: 10, paidAtTs: new Date('2026-07-01T10:00:00.000Z'), note: '我的缴费记录' },
    });
    const toolRegistry = requireRegistryFactory()({ prisma });
    const { conversationService, conversationId } = await createConversationFixture();

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来查询缴费',
            toolCalls: [{ id: 'call-payments-list', name: 'payments.list', args: {} }],
          },
        };
      }
      return { ok: true, value: { content: '你有 1 条缴费记录' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId, message: '列出缴费' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`agent converse failed: ${result.error.code}`);
    const secondCallMessages = getChatCalls(aiClient)[1][0];
    const toolMessages = secondCallMessages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('我的缴费记录');
  });
});
