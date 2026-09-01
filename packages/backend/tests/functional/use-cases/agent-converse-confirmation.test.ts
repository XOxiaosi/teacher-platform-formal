import { describe, expect, it, vi } from 'vitest';
import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
import { createAgentConverseUseCase } from '../../../src/app/use-cases/agent-converse/agent-converse-use-case.js';
import type { ConfirmationGateway } from '../../../src/app/confirmation/types.js';
import type { ConversationService } from '../../../src/features/conversation/index.js';
import type { AiClient, ChatResponse } from '../../../src/shared/ai-client/types.js';
import type { ToolDefinition, ToolRegistry } from '../../../src/shared/tool-registry/types.js';

const REQUIRED_TOOL: ToolDefinition = {
  name: 'students.updateStatus',
  description: '更新学生状态',
  parameters: { type: 'object' },
  sideEffect: 'update',
  confirmation: 'required',
};

const NORMAL_TOOL: ToolDefinition = {
  name: 'students.get',
  description: '查询学生',
  parameters: { type: 'object' },
  sideEffect: 'read',
  confirmation: 'none',
};

function conversationService() {
  const appended: Array<Record<string, unknown>> = [];
  const service = {
    appendTurn: vi.fn(async (input: Record<string, unknown>) => {
      appended.push(input);
      return ok({
        id: `turn-${appended.length}`,
        conversationId: String(input.conversationId),
        teacherId: String(input.teacherId),
        role: input.role as 'user' | 'assistant' | 'tool',
        content: String(input.content),
        toolCalls: input.toolCalls ?? null,
        toolResults: input.toolResults ?? null,
        audioFileRef: null,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      });
    }),
    buildContext: vi.fn(async () => ok([])),
  };
  return { service: service as unknown as ConversationService, appended };
}

function aiClient(responses: ChatResponse[]): AiClient {
  let index = 0;
  return {
    run: vi.fn(async () => ok({})),
    chat: vi.fn(async () => ok(responses[index++] ?? { content: 'done' })),
  };
}

function toolRegistry(definitions: ToolDefinition[]) {
  const execute = vi.fn(async () => ok({ ordinary: true }));
  const registry: ToolRegistry = {
    register: vi.fn(() => err(validationError('unused'))),
    list: vi.fn(() => definitions),
    execute,
  };
  return { registry, execute };
}

function gateway(result = ok({
  status: 'pending_confirmation' as const,
  pendingActionId: 'pending-1',
  summary: '学生将更新为 paused',
})) {
  const requestConfirmation = vi.fn(async () => result);
  return {
    gateway: { requestConfirmation } as ConfirmationGateway,
    requestConfirmation,
  };
}

describe('AgentConverse trusted confirmation interception', () => {
  it('required 工具只创建 PendingAction，写无 token tool turn，并立即停止模型循环', async () => {
    const conversations = conversationService();
    const ai = aiClient([{
      content: '准备更新',
      toolCalls: [{ id: 'call-1', name: REQUIRED_TOOL.name, args: { studentId: 'student-1', status: 'paused' } }],
    }]);
    const tools = toolRegistry([REQUIRED_TOOL]);
    const confirmation = gateway();
    const useCase = createAgentConverseUseCase({
      conversationService: conversations.service,
      aiClient: ai,
      toolRegistry: tools.registry,
      confirmationGateway: confirmation.gateway,
    });

    const result = await useCase.execute({
      teacherId: 'teacher-1', conversationId: 'conversation-1', message: '暂停学生',
    });

    expect(result).toEqual({
      ok: true,
      value: { conversationId: 'conversation-1', reply: '操作待确认，请在确认卡中核对后继续。' },
    });
    expect(confirmation.requestConfirmation).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'students.updateStatus',
      args: { studentId: 'student-1', status: 'paused' },
    });
    expect(tools.execute).not.toHaveBeenCalled();
    expect(ai.chat).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify({ result, turns: conversations.appended });
    expect(serialized).toContain('pending_confirmation');
    expect(serialized).not.toContain('actionToken');
    expect(serialized).not.toContain('must-not-leak-token');
  });

  it('遇到第一个 required 工具后不执行剩余 tool calls', async () => {
    const conversations = conversationService();
    const ai = aiClient([{
      content: '多个工具',
      toolCalls: [
        { id: 'call-required', name: REQUIRED_TOOL.name, args: { studentId: 'student-1', status: 'paused' } },
        { id: 'call-normal', name: NORMAL_TOOL.name, args: { studentId: 'student-1' } },
      ],
    }]);
    const tools = toolRegistry([REQUIRED_TOOL, NORMAL_TOOL]);
    const confirmation = gateway();

    await createAgentConverseUseCase({
      conversationService: conversations.service,
      aiClient: ai,
      toolRegistry: tools.registry,
      confirmationGateway: confirmation.gateway,
    }).execute({ teacherId: 'teacher-1', conversationId: 'conversation-1', message: '处理' });

    expect(confirmation.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(tools.execute).not.toHaveBeenCalled();
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });

  it('Gateway error 写入 tool error 后原样返回，且不继续模型', async () => {
    const conversations = conversationService();
    const ai = aiClient([{
      content: '准备更新',
      toolCalls: [{ id: 'call-1', name: REQUIRED_TOOL.name, args: {} }],
    }]);
    const tools = toolRegistry([REQUIRED_TOOL]);
    const confirmation = gateway(err(validationError('studentId 必须是非空字符串', 'studentId')));

    const result = await createAgentConverseUseCase({
      conversationService: conversations.service,
      aiClient: ai,
      toolRegistry: tools.registry,
      confirmationGateway: confirmation.gateway,
    }).execute({ teacherId: 'teacher-1', conversationId: 'conversation-1', message: '处理' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'studentId 必须是非空字符串', field: 'studentId' },
    });
    expect(conversations.appended.at(-1)).toMatchObject({
      role: 'tool', content: 'Error: studentId 必须是非空字符串', toolResults: { toolCallId: 'call-1' },
    });
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it('required 工具缺少 Gateway 时 fail-closed，不执行 handler', async () => {
    const conversations = conversationService();
    const ai = aiClient([{
      content: '准备更新',
      toolCalls: [{ id: 'call-1', name: REQUIRED_TOOL.name, args: {} }],
    }]);
    const tools = toolRegistry([REQUIRED_TOOL]);

    const result = await createAgentConverseUseCase({
      conversationService: conversations.service,
      aiClient: ai,
      toolRegistry: tools.registry,
    }).execute({ teacherId: 'teacher-1', conversationId: 'conversation-1', message: '处理' });

    expect(result).toEqual(err(internalError('ConfirmationGateway 未配置')));
    expect(tools.execute).not.toHaveBeenCalled();
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });

  it('普通工具保持 registry.execute 与下一轮模型调用', async () => {
    const conversations = conversationService();
    const ai = aiClient([
      { content: '查询', toolCalls: [{ id: 'call-read', name: NORMAL_TOOL.name, args: { studentId: 'student-1' } }] },
      { content: '查询完成' },
    ]);
    const tools = toolRegistry([NORMAL_TOOL]);

    const result = await createAgentConverseUseCase({
      conversationService: conversations.service,
      aiClient: ai,
      toolRegistry: tools.registry,
    }).execute({ teacherId: 'teacher-1', conversationId: 'conversation-1', message: '查询' });

    expect(result).toEqual(ok({ conversationId: 'conversation-1', reply: '查询完成' }));
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(ai.chat).toHaveBeenCalledTimes(2);
  });
});
