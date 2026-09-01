import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import type { AiClient } from '../../../src/shared/ai-client/types.js';
import type {
  AppendTurnInput,
  ConversationService,
  ConversationTurnData,
} from '../../../src/features/conversation/types.js';
import type {
  AgentExecutionData,
  AgentExecutionService,
} from '../../../src/features/agent-execution/types.js';
import type {
  ToolDefinition,
  ToolRegistry,
} from '../../../src/shared/tool-registry/types.js';
import { createAgentConverseUseCase } from '../../../src/app/use-cases/agent-converse/agent-converse-use-case.js';

const document = {
  schemaVersion: 1 as const,
  summary: '已创建学生张三。',
  sections: [],
  references: [{
    id: 'Student:student-1',
    type: 'Student' as const,
    objectId: 'student-1',
    label: '张三',
  }],
  actions: [],
};

const unused = async (): Promise<never> => {
  throw new Error('unexpected test dependency call');
};

function conversationService() {
  const appendTurn = vi.fn(async (input: AppendTurnInput) => ok<ConversationTurnData>({
    id: `turn-${input.role}`,
    conversationId: input.conversationId,
    teacherId: input.teacherId,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls ?? null,
    toolResults: input.toolResults ?? null,
    audioFileRef: input.audioFileRef ?? null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
  }));
  const buildContext = vi.fn(async () => ok([]));
  return {
    createConversation: unused,
    getConversation: unused,
    getConversationProjection: unused,
    listConversations: unused,
    appendTurn,
    listTurns: unused,
    listConversationTurnsPage: unused,
    buildContext,
    archiveConversation: unused,
    updateSummary: unused,
  } satisfies ConversationService;
}

const studentCreateDefinition: ToolDefinition = {
  name: 'students.create',
  description: '创建学生',
  parameters: {},
  sideEffect: 'create',
};

function toolRegistry(
  result: unknown,
  definitions: ToolDefinition[] = [studentCreateDefinition],
) {
  const execute = vi.fn<ToolRegistry['execute']>(async () => ok(result));
  return {
    register: () => {
      throw new Error('unexpected tool registration');
    },
    list: vi.fn(() => definitions),
    execute,
  } satisfies ToolRegistry;
}

function aiClient(chat: AiClient['chat']): AiClient {
  return {
    run: vi.fn(async () => ok({})),
    chat,
  };
}

function existingExecutionService(): AgentExecutionService {
  const instant = new Date('2030-01-01T00:00:00.000Z');
  const execution: AgentExecutionData = {
    id: 'execution-1',
    teacherId: 'teacher-1',
    conversationId: 'conversation-1',
    clientRequestId: 'request-1',
    requestFingerprint: 'fingerprint-1',
    userTurnId: 'turn-user',
    status: 'succeeded',
    stage: 'model',
    reply: '已完成',
    error: null,
    completedToolCallIds: [],
    startedAt: instant,
    finishedAt: instant,
    createdAt: instant,
    updatedAt: instant,
  };
  return {
    claim: vi.fn(async () => ok({ kind: 'existing' as const, execution })),
    complete: unused,
    fail: unused,
    get: unused,
    prepareReplay: unused,
  };
}

describe('Agent final Assistant presentation integration', () => {
  it('累计本轮成功工具结果，调用builder并把V1信封写入final Assistant turn', async () => {
    const conversations = conversationService();
    const registry = toolRegistry({ id: 'student-1', name: '张三', grade: '高三' });
    const chat = vi.fn<AiClient['chat']>()
      .mockResolvedValueOnce(ok({
        content: '正在创建',
        toolCalls: [{ id: 'call-1', name: 'students.create', args: { name: '张三', grade: '高三' } }],
      }))
      .mockResolvedValueOnce(ok({ content: '已创建学生张三。' }));
    const presentationBuilder = { build: vi.fn(() => document) };
    const useCase = createAgentConverseUseCase({
      conversationService: conversations,
      aiClient: aiClient(chat),
      toolRegistry: registry,
      presentationBuilder,
    });

    const result = await useCase.execute({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      message: '创建张三',
    });

    expect(result.ok).toBe(true);
    expect(presentationBuilder.build).toHaveBeenCalledWith({
      summary: '已创建学生张三。',
      toolResults: [{
        toolCallId: 'call-1',
        toolName: 'students.create',
        value: { id: 'student-1', name: '张三', grade: '高三' },
      }],
    });
    const finalAssistant = conversations.appendTurn.mock.calls
      .map(([input]) => input)
      .find((input) => input.role === 'assistant' && !input.toolCalls);
    expect(finalAssistant).toMatchObject({
      content: '已创建学生张三。',
      toolResults: {
        kind: 'assistant-presentation',
        version: 1,
        document,
      },
    });
  });

  it('无工具时仍通过builder保存fallback文档，reply字符串保持兼容', async () => {
    const conversations = conversationService();
    const presentationBuilder = { build: vi.fn(() => ({ ...document, summary: '普通回答。' })) };
    const chat = vi.fn<AiClient['chat']>(async () => ok({ content: '普通回答。' }));
    const useCase = createAgentConverseUseCase({
      conversationService: conversations,
      aiClient: aiClient(chat),
      toolRegistry: toolRegistry(undefined, []),
      presentationBuilder,
    });

    const result = await useCase.execute({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      message: '你好',
    });

    expect(result).toMatchObject({ ok: true, value: { reply: '普通回答。' } });
    expect(presentationBuilder.build).toHaveBeenCalledWith({ summary: '普通回答。', toolResults: [] });
    expect(conversations.appendTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'assistant',
      toolResults: expect.objectContaining({ kind: 'assistant-presentation', version: 1 }),
    }));
  });

  it('existing execution直接返回，不重复调用模型、工具或builder', async () => {
    const presentationBuilder = { build: vi.fn(() => document) };
    const chat = vi.fn<AiClient['chat']>();
    const registry = toolRegistry(undefined, []);
    const useCase = createAgentConverseUseCase({
      conversationService: conversationService(),
      aiClient: aiClient(chat),
      toolRegistry: registry,
      presentationBuilder,
      agentExecutions: existingExecutionService(),
    });

    const result = await useCase.execute({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      clientRequestId: 'request-1',
      message: '重复请求',
    });

    expect(result).toMatchObject({ ok: true, value: { replayed: true, reply: '已完成' } });
    expect(chat).not.toHaveBeenCalled();
    expect(registry.execute).not.toHaveBeenCalled();
    expect(presentationBuilder.build).not.toHaveBeenCalled();
  });

  it('waiting_confirmation只写确认轨迹，不构建伪成功presentation', async () => {
    const conversations = conversationService();
    const presentationBuilder = { build: vi.fn(() => document) };
    const chat = vi.fn<AiClient['chat']>(async () => ok({
      content: '等待确认',
      toolCalls: [{
        id: 'call-confirm',
        name: 'students.updateStatus',
        args: { studentId: 'student-1', status: 'paused' },
      }],
    }));
    const useCase = createAgentConverseUseCase({
      conversationService: conversations,
      aiClient: aiClient(chat),
      toolRegistry: toolRegistry(undefined, [{
        name: 'students.updateStatus',
        description: '更新状态',
        parameters: { type: 'object', properties: { studentId: {}, status: {} } },
        sideEffect: 'update',
        confirmation: 'required',
      }]),
      confirmationGateway: {
        requestConfirmation: vi.fn(async () => ok({
          status: 'pending_confirmation' as const,
          pendingActionId: 'pending-1',
          summary: '暂停学生张三',
        })),
      },
      presentationBuilder,
    });

    const result = await useCase.execute({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      message: '暂停学生',
    });

    expect(result).toMatchObject({
      ok: true,
      value: { reply: '操作待确认，请在确认卡中核对后继续。' },
    });
    expect(presentationBuilder.build).not.toHaveBeenCalled();
    expect(conversations.appendTurn.mock.calls.map(([input]) => input.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });
});
