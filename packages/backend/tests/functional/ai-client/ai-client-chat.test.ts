import { describe, it, expect } from 'vitest';
import { createAiClient } from '../../../src/shared/ai-client/ai-client.js';
import type { AiProvider, ChatMessage, ChatToolDefinition, ChatResponse } from '../../../src/shared/ai-client/types.js';

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是一个助手' },
  { role: 'user', content: '帮我创建学生张三' },
];

const SAMPLE_TOOLS: ChatToolDefinition[] = [
  { name: 'createStudent', description: '创建学生', parameters: { name: { type: 'string' } } },
];

const SAMPLE_RESPONSE: ChatResponse = {
  content: '好的，已创建',
  toolCalls: [{ id: 'call-1', name: 'createStudent', args: { name: '张三' } }],
};

describe('aiClient.chat', () => {
  it('校验 messages 非空', async () => {
    const provider: AiProvider = { run: async () => ({}), chat: async () => SAMPLE_RESPONSE };
    const client = createAiClient({ provider });

    const result = await client.chat([], SAMPLE_TOOLS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('messages');
  });

  it('校验 tools 必须是数组', async () => {
    const provider: AiProvider = { run: async () => ({}), chat: async () => SAMPLE_RESPONSE };
    const client = createAiClient({ provider });

    const result = await client.chat(SAMPLE_MESSAGES, null as never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('tools');
  });

  it('provider.chat 缺失时返回 INTERNAL_ERROR', async () => {
    const provider: AiProvider = { run: async () => ({}) }; // 无 chat 方法
    const client = createAiClient({ provider });

    const result = await client.chat(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('不支持 chat');
  });

  it('provider.chat 成功时返回 ok，包含 content 与 toolCalls', async () => {
    let capturedMessages: ChatMessage[] | undefined;
    let capturedTools: ChatToolDefinition[] | undefined;

    const provider: AiProvider = {
      run: async () => ({}),
      chat: async (messages, tools) => {
        capturedMessages = messages;
        capturedTools = tools;
        return SAMPLE_RESPONSE;
      },
    };
    const client = createAiClient({ provider });

    const result = await client.chat(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('好的，已创建');
    expect(result.value.toolCalls).toHaveLength(1);
    expect(result.value.toolCalls![0].name).toBe('createStudent');
    // 断言 provider.chat 收到的是同一个引用
    expect(capturedMessages).toBe(SAMPLE_MESSAGES);
    expect(capturedTools).toBe(SAMPLE_TOOLS);
  });

  it('provider.chat 抛异常时返回 INTERNAL_ERROR', async () => {
    const provider: AiProvider = {
      run: async () => ({}),
      chat: async () => { throw new Error('网络超时'); },
    };
    const client = createAiClient({ provider });

    const result = await client.chat(SAMPLE_MESSAGES, SAMPLE_TOOLS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('网络超时');
  });
});

describe('aiClient.run 不回归', () => {
  it('run() 原有成功行为', async () => {
    const provider: AiProvider = {
      run: async () => ({ text: '明天下午三点上课' }),
    };
    const client = createAiClient({ provider });

    const result = await client.run({ taskType: 'speech_to_text', input: '音频数据' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('明天下午三点上课');
  });

  it('run() 输入为空仍返回 VALIDATION_ERROR', async () => {
    const provider: AiProvider = { run: async () => ({}) };
    const client = createAiClient({ provider });

    const result = await client.run({ taskType: 'speech_to_text', input: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('input');
  });
});
