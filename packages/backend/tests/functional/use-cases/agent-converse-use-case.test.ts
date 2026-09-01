import { describe, it, expect, vi } from 'vitest';
import type { AiClient, ChatMessage, ChatResponse, ChatToolDefinition } from '../../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';

// Phase 1.10-A: 红灯测试
// agent-converse use-case 不存在，import 会失败。
// 测试锁定 Phase 1.10 预期契约，实现将在 Phase 1.10-B 完成。
//
// 最小契约：
//   createAgentConverseUseCase({ conversationService, aiClient, toolRegistry })
//   .execute({ teacherId, conversationId, message })
//   -> Result<{ conversationId: string; reply: string }, CommonError>

// 尝试 import（当前会失败）
let createAgentConverseUseCase: any;
try {
  const mod = await import('../../../src/app/use-cases/agent-converse/agent-converse-use-case.js');
  createAgentConverseUseCase = mod.createAgentConverseUseCase;
} catch {
  // 模块不存在，测试会失败
}

const TEACHER_ID = 'test-teacher-agent-converse';

// ---- 辅助：创建 mock conversation service ----
function createMockConversationService() {
  return {
    createConversation: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'conv-1', teacherId: TEACHER_ID, status: 'active', summary: null, createdAt: new Date(), updatedAt: new Date() },
    }),
    getConversation: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'conv-1', teacherId: TEACHER_ID, status: 'active', summary: null, createdAt: new Date(), updatedAt: new Date() },
    }),
    appendTurn: vi.fn().mockImplementation(async (input: any) => ({
      ok: true,
      value: {
        id: `turn-${Date.now()}`,
        conversationId: input.conversationId,
        teacherId: input.teacherId,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ?? null,
        toolResults: input.toolResults ?? null,
        audioFileRef: null,
        createdAt: new Date(),
      },
    })),
    listTurns: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    buildContext: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    archiveConversation: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'conv-1', teacherId: TEACHER_ID, status: 'archived', summary: null, createdAt: new Date(), updatedAt: new Date() },
    }),
    updateSummary: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'conv-1', teacherId: TEACHER_ID, status: 'active', summary: '', createdAt: new Date(), updatedAt: new Date() },
    }),
  };
}

// ---- 辅助：创建 mock ai-client（返回 Result） ----
function createMockAiClient(chatFn: (messages: ChatMessage[], tools: ChatToolDefinition[]) => Promise<Result<ChatResponse, CommonError>>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(chatFn),
  };
}

// ---- 辅助：创建 mock tool-registry ----
function createMockToolRegistry() {
  const handlers = new Map<string, (args: unknown, context: unknown) => Promise<Result<unknown, CommonError>>>();
  return {
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockImplementation(async (name: string, args: unknown, context: unknown) => {
      const handler = handlers.get(name);
      if (!handler) return { ok: false, error: { code: 'NOT_FOUND', message: `工具 ${name} 未注册` } };
      return handler(args, context);
    }),
    _setHandler: (name: string, handler: (args: unknown, context: unknown) => Promise<Result<unknown, CommonError>>) => {
      handlers.set(name, handler);
    },
  };
}

// ---- 测试 ----

describe('agentConverse use-case 契约（Phase 1.10-A 红灯）', () => {
  it('模块不存在时 import 失败', () => {
    // 这是红灯的基本保证：模块不存在
    expect(createAgentConverseUseCase).toBeDefined();
  });

  it('保存 user turn：调用后应 append user turn 到 conversation', async () => {
    if (!createAgentConverseUseCase) return; // 模块不存在，跳过

    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '你好', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '帮我创建学生张三' });

    // 应该调用 appendTurn 保存 user turn
    expect(conversationService.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        teacherId: TEACHER_ID,
        role: 'user',
        content: '帮我创建学生张三',
      }),
    );
  });

  it('无 toolCalls 时保存 assistant turn 并返回 reply', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '你好，我是 AI 助手', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '你好' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reply).toBe('你好，我是 AI 助手');
    expect(result.value.conversationId).toBe('conv-1');

    // 应该调用 appendTurn 保存 assistant turn
    expect(conversationService.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: '你好，我是 AI 助手',
      }),
    );
  });

  it('有 toolCalls 时执行 registry handler，再调用第二次 chat', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // 第一次返回 tool_calls（Result ok）
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'createStudent', args: { name: '张三' } }],
          },
        };
      }
      // 第二次返回最终回复
      return { ok: true, value: { content: '已创建学生张三', toolCalls: undefined } };
    });

    const toolRegistry = createMockToolRegistry();
    toolRegistry._setHandler('createStudent', async () => ({ ok: true, value: { id: 'student-1' } }));

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '帮我创建学生张三' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reply).toBe('已创建学生张三');

    // 应该调用两次 chat
    expect(aiClient.chat).toHaveBeenCalledTimes(2);
    // 应该执行工具
    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'createStudent',
      { name: '张三' },
      expect.objectContaining({ teacherId: TEACHER_ID }),
    );
  });

  it('tool 返回错误时写入 tool result，不吞错', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // 第一次返回 tool_calls，触发 tool 执行
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'createStudent', args: { name: '' } }],
          },
        };
      }
      // 第二次返回最终回复（tool 失败后的回复）
      return { ok: true, value: { content: '创建失败，请重试', toolCalls: undefined } };
    });

    const toolRegistry = createMockToolRegistry();
    // tool handler 返回错误
    toolRegistry._setHandler('createStudent', async () => ({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '姓名不能为空', field: 'name' },
    }));

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '帮我创建学生' });

    // 应该调用 appendTurn 保存 tool result（包含错误信息）
    const toolTurnCall = (conversationService.appendTurn as any).mock.calls.find(
      (call: any) => call[0].role === 'tool',
    );
    expect(toolTurnCall).toBeDefined();
    // tool result 应包含错误信息，不被吞掉
    const toolTurnContent = toolTurnCall[0].content;
    expect(toolTurnContent).toContain('姓名不能为空');
  });

  it('超过 5 轮 tool 调用后停止', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {} }],
      },
    }));

    const toolRegistry = createMockToolRegistry();
    toolRegistry._setHandler('testTool', async () => ({ ok: true, value: {} }));

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '无限循环测试' });

    // 应该在 5 轮后停止，chat 调用次数不超过 6（初始 + 5 轮工具调用）
    expect(aiClient.chat).toHaveBeenCalledTimes(6);
    // 结果应该是错误或受控终止
    expect(result).toBeDefined();
  });

  it('中途失败追加 error/tool turn，不回滚已完成业务操作', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // 第一次返回 tool_calls
        return {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'testTool', args: {} }],
          },
        };
      }
      // 第二次返回 Result err（模拟 AI 服务失败）
      return {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'AI 服务异常' },
      };
    });

    const toolRegistry = createMockToolRegistry();
    toolRegistry._setHandler('testTool', async () => ({ ok: true, value: { result: 'ok' } }));

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '测试失败回滚' });

    // 即使第二次 chat 失败，之前的 tool turn 应该已经被保存
    const appendCalls = (conversationService.appendTurn as any).mock.calls;
    // 应该有 user turn + tool turn（至少 2 个）
    expect(appendCalls.length).toBeGreaterThanOrEqual(2);

    // 结果应该是错误
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('用户消息不重复：buildContext 返回的上下文已含 user turn，chat 不应再拼一次', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    // mock buildContext 返回包含 user turn 的上下文
    conversationService.buildContext = vi.fn().mockResolvedValue({
      ok: true,
      value: [{ role: 'user', content: '你好' }],
    });

    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '你好，我是 AI 助手', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '你好' });

    // 断言 aiClient.chat 第一次收到的 messages 中 user/content='你好' 只出现 1 次
    const chatCalls = (aiClient.chat as any).mock.calls;
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    const firstCallMessages = chatCalls[0][0] as ChatMessage[];
    const userMessages = firstCallMessages.filter((m: ChatMessage) => m.role === 'user' && m.content === '你好');
    expect(userMessages).toHaveLength(1);
  });

  it('每轮模型调用前注入数据库可信时间和 Asia/Shanghai 日期上下文', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    conversationService.buildContext = vi.fn().mockResolvedValue({
      ok: true,
      value: [{
        role: 'tool',
        content: '{"name":"某学生","createdAt":"2026-07-11T02:25:21.793Z"}',
        toolCallId: 'call-students-list',
      }],
    });
    const trustedClock = {
      now: vi.fn().mockResolvedValue({
        ok: true,
        value: new Date('2026-07-25T07:48:00.000Z'),
      }),
    };
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '下周从 7 月 27 日开始', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();

    const useCase = createAgentConverseUseCase({
      conversationService,
      aiClient,
      toolRegistry,
      trustedClock,
      businessTimeZone: 'Asia/Shanghai',
    } as any);
    await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: 'conv-1',
      message: '下周开始排课',
    });

    expect(trustedClock.now).toHaveBeenCalledTimes(1);
    const firstCallMessages = (aiClient.chat as any).mock.calls[0][0] as ChatMessage[];
    expect(firstCallMessages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(firstCallMessages[0].content).toContain('2026-07-25');
    expect(firstCallMessages[0].content).toContain('星期六');
    expect(firstCallMessages[0].content).toContain('Asia/Shanghai');
    expect(firstCallMessages[0].content).toContain('createdAt');
  });

  it('可信时钟不可用时不调用模型并 fail-closed', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    const trustedClock = {
      now: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '数据库可信时间不可用' },
      }),
    };
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '不应调用', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();

    const useCase = createAgentConverseUseCase({
      conversationService,
      aiClient,
      toolRegistry,
      trustedClock,
      businessTimeZone: 'Asia/Shanghai',
    } as any);
    const result = await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: 'conv-1',
      message: '下周开始排课',
    });

    expect(result.ok).toBe(false);
    expect(aiClient.chat).not.toHaveBeenCalled();
  });

  it('工具续接后的下一轮模型调用重新读取可信时钟', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    const trustedClock = {
      now: vi.fn().mockResolvedValue({
        ok: true,
        value: new Date('2026-07-25T07:48:00.000Z'),
      }),
    };
    let chatCallCount = 0;
    const aiClient = createMockAiClient(async () => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return {
          ok: true,
          value: {
            content: '查询中',
            toolCalls: [{ id: 'call-read', name: 'test.read', args: {} }],
          },
        };
      }
      return { ok: true, value: { content: '查询完成', toolCalls: undefined } };
    });
    const toolRegistry = createMockToolRegistry();
    toolRegistry._setHandler('test.read', async () => ({ ok: true, value: { items: [] } }));

    const useCase = createAgentConverseUseCase({
      conversationService,
      aiClient,
      toolRegistry,
      trustedClock,
      businessTimeZone: 'Asia/Shanghai',
    } as any);
    await useCase.execute({
      teacherId: TEACHER_ID,
      conversationId: 'conv-1',
      message: '查一下课程',
    });

    expect(aiClient.chat).toHaveBeenCalledTimes(2);
    expect(trustedClock.now).toHaveBeenCalledTimes(2);
  });

  it('超过 5 轮工具调用限制：toolRegistry.execute 最多调用 5 次', async () => {
    if (!createAgentConverseUseCase) return;

    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'testTool', args: {} }],
      },
    }));

    const toolRegistry = createMockToolRegistry();
    toolRegistry._setHandler('testTool', async () => ({ ok: true, value: {} }));

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '无限循环测试' });

    // toolRegistry.execute 最多调用 5 次，不是 6 次
    expect(toolRegistry.execute).toHaveBeenCalledTimes(5);
    // 结果应该是错误
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});
