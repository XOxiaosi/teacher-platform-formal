import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createArkAiProvider } from '../../../src/shared/ai-client/ark-provider.js';
import type { ChatMessage, ChatToolDefinition } from '../../../src/shared/ai-client/types.js';

// Phase 1.9-A: 红灯测试
// 这些测试锁定 ark-provider chat 的预期契约。
// 当前 ark-provider 未实现 chat，测试应全部失败。
// 实现在 Phase 1.9-B 完成，本文件禁止修改生产代码。

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是一个助手' },
  { role: 'user', content: '帮我创建学生张三' },
];

const SAMPLE_TOOLS: ChatToolDefinition[] = [
  {
    name: 'createStudent',
    description: '创建学生',
    parameters: { name: { type: 'string' }, grade: { type: 'string' } },
  },
];

function createProvider() {
  return createArkAiProvider({
    apiKey: 'test-key',
    baseUrl: 'https://ark.example.com/api/v3',
    model: 'test-model',
  });
}

// 保存原始 fetch
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // 每个测试前重置 fetch mock
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ark-provider.chat 契约（Phase 1.9-A 红灯）', () => {
  it('createArkAiProvider 返回的 provider 暴露 chat 方法', () => {
    const provider = createProvider();

    // Phase 1.9 预期：chat 方法应存在
    expect(provider.chat).toBeTypeOf('function');
  });

  it('chat 向 Ark chat completions 接口发送 messages 和 tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '好的' } }],
      }),
    });
    globalThis.fetch = fetchMock;

    const provider = createProvider();
    // chat 应存在，如果不存在此断言会失败
    expect(provider.chat).toBeTypeOf('function');
    await provider.chat!(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    // 断言 fetch 被调用
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];

    // 应请求 chat completions 端点
    expect(url).toContain('/chat/completions');
    expect(options.method).toBe('POST');

    // body 应包含 messages 和 tools
    const body = JSON.parse(options.body);
    expect(body.messages).toEqual(SAMPLE_MESSAGES);
    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('createStudent');
  });

  it('chat 将内部 toolCallId/toolCalls 映射为 OpenAI 兼容 snake_case 协议', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '完成' } }] }),
    });
    globalThis.fetch = fetchMock;
    const provider = createProvider();

    await provider.chat!([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'createStudent', args: { name: '张三' } }] },
      { role: 'tool', content: '{"id":"student-1"}', toolCallId: 'call-1' },
    ], SAMPLE_TOOLS);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'createStudent', arguments: '{"name":"张三"}' },
        }],
      },
      { role: 'tool', content: '{"id":"student-1"}', tool_call_id: 'call-1' },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain('toolCallId');
    expect(JSON.stringify(body.messages)).not.toContain('toolCalls');
  });

  it('chat 把 Ark 返回的 assistant content 映射为 ChatResponse.content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '好的，我来创建学生张三',
          },
        }],
      }),
    });
    globalThis.fetch = fetchMock;

    const provider = createProvider();
    const result = await provider.chat!(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    expect(result.content).toBe('好的，我来创建学生张三');
    expect(result.toolCalls).toBeUndefined();
  });

  it('chat 把 Ark 返回的 tool_calls 映射为 ToolCall[]', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-abc123',
                type: 'function',
                function: {
                  name: 'createStudent',
                  arguments: '{"name":"张三","grade":"高三"}',
                },
              },
            ],
          },
        }],
      }),
    });
    globalThis.fetch = fetchMock;

    const provider = createProvider();
    const result = await provider.chat!(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toEqual({
      id: 'call-abc123',
      name: 'createStudent',
      args: { name: '张三', grade: '高三' },
    });
  });

  it('Ark 返回非 2xx 时 chat 抛出错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Invalid request' },
      }),
    });
    globalThis.fetch = fetchMock;

    const provider = createProvider();

    // chat 应抛出错误，让 createAiClient.chat 包装为 INTERNAL_ERROR
    await expect(provider.chat!(SAMPLE_MESSAGES, SAMPLE_TOOLS)).rejects.toThrow();
  });
});
