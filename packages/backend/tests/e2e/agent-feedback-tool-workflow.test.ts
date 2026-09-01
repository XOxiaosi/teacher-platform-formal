import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createConversationService } from '../../src/features/conversation/conversation-service.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import type { AiClient, ChatMessage, ChatToolDefinition, ToolCall } from '../../src/shared/ai-client/types.js';
import type { ToolRegistry } from '../../src/shared/tool-registry/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批1：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

// Phase 3.5-A: 红灯测试
// createMinimalToolRegistry 当前不包含 feedback 基础工具。
// 测试锁定 Agent 通过 feedback.create / feedback.list 调用真实工具的工作流。

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

const prisma = new PrismaClient();
const TEACHER_ID = 'test-teacher-feedback-workflow';

async function cleanup() {
  const teacherIds = [TEACHER_ID];
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: { teacherId, name, grade: '高一', source: 'test' },
  });
}

function getChatCalls(aiClient: AiClient): Array<[ChatMessage[], ChatToolDefinition[]]> {
  return (aiClient.chat as unknown as { mock: { calls: Array<[ChatMessage[], ChatToolDefinition[]]> } }).mock.calls;
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

describe('Agent feedback 工具 workflow（Phase 3.5-A 红灯）', () => {
  it('createMinimalToolRegistry 注册 feedback 基础工具', () => {
    const registry = requireRegistryFactory()({ prisma });
    const toolNames = registry.list().map((tool) => tool.name);

    expect(toolNames).toContain('feedback.create');
    expect(toolNames).toContain('feedback.list');
    expect(toolNames).toContain('feedback.updateStatus');
  });

  it('mock aiClient 返回 feedback.create toolCall，agent-converse 执行真实工具并返回 reply', async () => {
    const student = await createStudentFixture(TEACHER_ID, '张三');
    const toolRegistry = requireRegistryFactory()({ prisma });
    const conversationService = createConversationService({ prisma });
    const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
    if (!convResult.ok) throw new Error('创建 conversation 失败');

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来创建家长反馈',
            toolCalls: [{
              id: 'call-feedback-create',
              name: 'feedback.create',
              args: {
                studentId: student.id,
                title: '张三学习反馈',
                content: '张三本周物理课堂状态稳定。',
                channel: 'wechat',
                parentName: '张三妈妈',
              },
            }],
          },
        };
      }
      return { ok: true, value: { content: '已创建张三学习反馈' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: convResult.value.id,
      message: '给张三创建一条家长反馈',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reply).toContain('张三学习反馈');

    const feedbacks = await prisma.parentFeedback.findMany({ where: { teacherId: TEACHER_ID } });
    expect(feedbacks).toHaveLength(1);
    expect(feedbacks[0].studentId).toBe(student.id);
    // P8 phase-3 批1：title 落库为密文，解密后为原文
    expect(feedbacks[0].title).not.toBe('张三学习反馈');
    expect(cipher.decrypt(feedbacks[0].title)).toBe('张三学习反馈');
  });

  it('mock aiClient 返回 feedback.list toolCall，读取当前 teacher 反馈', async () => {
    const student = await createStudentFixture(TEACHER_ID, '李四');
    await prisma.parentFeedback.create({
      data: { teacherId: TEACHER_ID, studentId: student.id, title: '我的反馈', content: '我的反馈内容' },
    });

    const toolRegistry = requireRegistryFactory()({ prisma });
    const conversationService = createConversationService({ prisma });
    const convResult = await conversationService.createConversation({ teacherId: TEACHER_ID });
    if (!convResult.ok) throw new Error('创建 conversation 失败');

    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '我来查看家长反馈',
            toolCalls: [{ id: 'call-feedback-list', name: 'feedback.list', args: {} }],
          },
        };
      }
      return { ok: true, value: { content: '你有 1 条家长反馈' } };
    });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: convResult.value.id,
      message: '列出我的家长反馈',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const secondCallMessages = getChatCalls(aiClient)[1][0];
    const toolMessages = secondCallMessages.filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('我的反馈');
  });
});
