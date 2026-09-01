import { describe, it, expect, vi } from 'vitest';
import type { AiClient, ChatMessage, ChatResponse, ChatToolDefinition } from '../../../src/shared/ai-client/types.js';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { ok } from '@teacher-platform/contracts';
import { createAgentConverseUseCase } from '../../../src/app/use-cases/agent-converse/index.js';
import { createBudgetTracker, estimateTokens } from '../../../src/shared/agent-cost/index.js';

// t53（P2修复2）：Agent 成本控制装配进 agent-converse——预算超限 BUDGET_EXCEEDED、历史截断、未超限正常。

const TEACHER_ID = 'test-teacher-agent-budget';

function createMockConversationService(context: Array<{ role: string; content: string; toolCalls?: unknown; toolCallId?: string | null }> = []) {
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
    buildContext: vi.fn().mockResolvedValue({ ok: true, value: context }),
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

function createMockAiClient(chatFn: (messages: ChatMessage[], tools: ChatToolDefinition[]) => Promise<Result<ChatResponse, CommonError>>): AiClient {
  return {
    run: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    chat: vi.fn(chatFn),
  };
}

function createMockToolRegistry() {
  return {
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  };
}

describe('agentConverse 成本控制装配（t53）', () => {
  it('单轮超限：checkAndConsume turnExceeded → BUDGET_EXCEEDED，不调用模型', async () => {
    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '不应被调用', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();
    const budgetTracker = createBudgetTracker({ dailyTokenLimit: 100000, perTurnTokenLimit: 10 });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry, budgetTracker, perTurnTokenLimit: 10 });
    const longMessage = '这是一段超过单轮预算的长用户消息，用于触发 turnExceeded';
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: longMessage });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BUDGET_EXCEEDED');
    expect(aiClient.chat).not.toHaveBeenCalled();
    // 超限不记账：预算未消耗
    expect(budgetTracker.usedToday(TEACHER_ID)).toBe(0);
  });

  it('每日超限：预算耗尽后 → BUDGET_EXCEEDED（今日预算已用尽），不调用模型', async () => {
    const conversationService = createMockConversationService();
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '不应被调用', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();
    const budgetTracker = createBudgetTracker({ dailyTokenLimit: 100, perTurnTokenLimit: 1000 });

    // 先占满每日预算
    const consumed = budgetTracker.checkAndConsume(TEACHER_ID, 100);
    expect(consumed.ok).toBe(true);

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry, budgetTracker, perTurnTokenLimit: 1000 });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '今日额度已尽' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BUDGET_EXCEEDED');
    expect(aiClient.chat).not.toHaveBeenCalled();
  });

  it('截断生效：长历史超 perTurn 预算时丢弃最旧回合，system 首条恒保留、最新保留', async () => {
    const systemMsg = '当前时间上下文锚点';
    const context = [
      { role: 'system' as const, content: systemMsg },
      { role: 'user' as const, content: '最早的对话内容之一' },
      { role: 'assistant' as const, content: '较早的回复内容' },
      { role: 'user' as const, content: '中段的对话内容' },
      { role: 'assistant' as const, content: '较新的回复内容' },
      { role: 'user' as const, content: '最新的用户消息' },
    ];
    const conversationService = createMockConversationService(context);
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '收到', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();
    const budgetTracker = createBudgetTracker({ dailyTokenLimit: 100000, perTurnTokenLimit: 1000 });
    // 小单轮预算强制截断：只够 system + 最新 1-2 条
    const perTurnTokenLimit = estimateTokens(systemMsg) + estimateTokens(context[5].content) + 2;

    const useCase = createAgentConverseUseCase({
      conversationService,
      aiClient,
      toolRegistry,
      budgetTracker,
      perTurnTokenLimit,
      trustedClock: { now: vi.fn().mockResolvedValue(ok(new Date('2026-08-21T08:00:00.000Z'))) },
    });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '查一下' });

    expect(result.ok).toBe(true);
    const sentMessages = (aiClient.chat as unknown as { mock: { calls: Array<[ChatMessage[]]> } }).mock.calls[0][0];
    // 截断后长度小于原始（原始 6 条 + trustedClock 插入的 system = 7）
    expect(sentMessages.length).toBeLessThan(context.length + 1);
    // system 首条（trustedClock 时间锚点）恒保留在首位
    expect(sentMessages[0].role).toBe('system');
    // 最新用户消息保留
    expect(sentMessages.map((m) => m.content)).toContain('最新的用户消息');
    // 最旧业务内容被丢弃
    expect(sentMessages.map((m) => m.content)).not.toContain('最早的对话内容之一');
    expect(sentMessages.map((m) => m.content)).not.toContain('较早的回复内容');
  });

  it('未超限正常：预算充足时完整执行，历史不截断', async () => {
    const context = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: '你好，需要我做什么？' },
    ];
    const conversationService = createMockConversationService(context);
    const aiClient = createMockAiClient(async () => ({
      ok: true,
      value: { content: '好的，已了解', toolCalls: undefined },
    }));
    const toolRegistry = createMockToolRegistry();
    const budgetTracker = createBudgetTracker({ dailyTokenLimit: 100000, perTurnTokenLimit: 100000 });

    const useCase = createAgentConverseUseCase({ conversationService, aiClient, toolRegistry, budgetTracker, perTurnTokenLimit: 100000 });
    const result = await useCase.execute({ teacherId: TEACHER_ID, conversationId: 'conv-1', message: '查看学生' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(aiClient.chat).toHaveBeenCalledTimes(1);
    const sentMessages = (aiClient.chat as unknown as { mock: { calls: Array<[ChatMessage[]]> } }).mock.calls[0][0];
    // 未截断：原始 2 条全部保留
    expect(sentMessages.map((m) => m.content)).toEqual(['你好', '你好，需要我做什么？']);
    // 记账生效：已用 = 本条消息 token
    expect(budgetTracker.usedToday(TEACHER_ID)).toBe(estimateTokens('查看学生'));
  });
});
