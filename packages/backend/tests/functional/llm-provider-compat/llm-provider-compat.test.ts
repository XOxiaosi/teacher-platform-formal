import { describe, it, expect } from 'vitest';
import {
  createOpenAiCompatAdapter,
} from '../../../src/shared/llm-provider-compat/openai-compat.js';
import {
  createAnthropicAdapter,
} from '../../../src/shared/llm-provider-compat/anthropic.js';
import {
  buildProviderPayload,
  resolveAdapter,
  stripEmptyTools,
} from '../../../src/shared/llm-provider-compat/dispatcher.js';
import {
  createLlmProvider,
} from '../../../src/shared/llm-provider-compat/index.js';
import type {
  ChatMessage,
  NormalizedRequest,
} from '../../../src/shared/llm-provider-compat/types.js';
import type { DnsLookup } from '../../../src/shared/ssrf/endpoint-guard.js';

/** 测试用 DNS：hostname 一律解析到公网 TEST-NET（避免真实网络依赖）。 */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

const OPENAI_CONFIG = { providerKind: 'openai', providerName: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' };
const ANTHROPIC_CONFIG = { providerKind: 'anthropic', providerName: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', model: 'claude-3-5-sonnet-latest' };

function chatRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
    temperature: 0,
    ...overrides,
  };
}

describe('resolveAdapter 分发', () => {
  it('openai → openai-compat；anthropic → anthropic；未知协议族回退 openai', () => {
    expect(resolveAdapter('openai').kind).toBe('openai');
    expect(resolveAdapter('anthropic').kind).toBe('anthropic');
    expect(resolveAdapter('unknown').kind).toBe('openai'); // 兜底
  });
});

describe('stripEmptyTools 通用补丁', () => {
  it('无 tools 时剥除空数组字段（DeepSeek 兼容）', () => {
    const stripped = stripEmptyTools(chatRequest());
    expect('tools' in stripped).toBe(false);
  });

  it('有 tools 时保留', () => {
    const req = chatRequest({ tools: [{ name: 't', description: 'd', parameters: {} }] });
    const kept = stripEmptyTools(req);
    expect(kept.tools).toHaveLength(1);
  });
});

describe('openai-compat 适配器', () => {
  const adapter = createOpenAiCompatAdapter();

  it('payload：messages 直通 + tools 转 function 结构 + 参数白名单', () => {
    const payload = adapter.buildPayload(chatRequest({
      tools: [
        { name: 'students.get', description: '查询学生', parameters: { type: 'object', properties: {} } },
      ],
    })) as Record<string, unknown>;
    expect(payload.model).toBe('test-model');
    expect(payload.messages).toHaveLength(2);
    expect(payload.tools).toEqual([{
      type: 'function',
      function: { name: 'students.get', description: '查询学生', parameters: { type: 'object', properties: {} } },
    }]);
  });

  it('assistant tool_calls / tool 消息序列化（往返）', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '调用工具', toolCalls: [{ id: 'tc1', name: 'students.get', args: { id: 's1' } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc1' },
    ];
    const payload = adapter.buildPayload(chatRequest({ messages })) as { messages: unknown[] };
    const serialized = payload.messages as Array<Record<string, unknown>>;
    expect(serialized[0].role).toBe('assistant');
    expect((serialized[0].tool_calls as Array<{ function: { name: string; arguments: string } }>)[0].function.arguments)
      .toBe('{"id":"s1"}');
    expect(serialized[1]).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'tc1' });
  });

  it('parseResponse：content + tool_calls + usage', () => {
    const response = adapter.parseResponse({
      choices: [{
        message: {
          content: '查询结果',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'students.get', arguments: '{"id":"s1"}' } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(response.content).toBe('查询结果');
    expect(response.toolCalls).toEqual([{ id: 'tc1', name: 'students.get', args: { id: 's1' } }]);
    expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('参数白名单清洗：非法顶层参数剥除（智谱 temperature 差异防御）', () => {
    const raw = adapter.buildPayload(chatRequest()) as Record<string, unknown>;
    expect(Object.keys(raw).every((key) => ['model', 'messages', 'temperature', 'tools', 'stream'].includes(key))).toBe(true);
  });

  it('错误归一四类：401→auth / 429→rate_limited / 404→model_not_found / 5xx→provider_down', () => {
    expect(adapter.normalizeError(401, { error: { message: 'invalid key' } }).kind).toBe('auth');
    expect(adapter.normalizeError(403, {}).kind).toBe('auth');
    expect(adapter.normalizeError(429, { error: { message: 'rate limit' } }).kind).toBe('rate_limited');
    expect(adapter.normalizeError(429, {}).retryable).toBe(true);
    expect(adapter.normalizeError(404, {}).kind).toBe('model_not_found');
    expect(adapter.normalizeError(400, {}).kind).toBe('invalid_request');
    expect(adapter.normalizeError(422, {}).kind).toBe('invalid_request');
    expect(adapter.normalizeError(503, {}).kind).toBe('provider_down');
    expect(adapter.normalizeError(500, {}).retryable).toBe(true);
    expect(adapter.normalizeError(418, {}).kind).toBe('unknown');
  });
});

describe('anthropic 适配器', () => {
  const adapter = createAnthropicAdapter();

  it('matches：providerKind=anthropic 或 providerName=claude 命中', () => {
    expect(adapter.matches(ANTHROPIC_CONFIG)).toBe(true);
    expect(adapter.matches({ ...ANTHROPIC_CONFIG, providerName: 'claude' })).toBe(true);
    expect(adapter.matches(OPENAI_CONFIG)).toBe(false);
  });

  it('payload：system 拆出、user/assistant 转 content blocks、tool_use 转换', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '规则' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '调工具', toolCalls: [{ id: 'tc1', name: 'students.get', args: { id: 's1' } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'tc1' },
    ];
    const payload = adapter.buildPayload(chatRequest({ messages, tools: [{ name: 'students.get', description: '查学生', parameters: { type: 'object' } }] })) as Record<string, unknown>;
    expect(payload.system).toBe('规则');
    const anthroMessages = payload.messages as Array<{ role: string; content: unknown[] }>;
    expect(anthroMessages).toHaveLength(3); // system 已拆出
    const toolUse = anthroMessages[1].content.find((block) => (block as { type: string }).type === 'tool_use');
    expect(toolUse).toEqual({ type: 'tool_use', id: 'tc1', name: 'students.get', input: { id: 's1' } });
    const toolResult = anthroMessages[2].content[0];
    expect(toolResult).toEqual({ type: 'tool_result', tool_use_id: 'tc1', content: '{"ok":true}' });
    expect(payload.tools).toEqual([{ name: 'students.get', description: '查学生', input_schema: { type: 'object' } }]);
  });

  it('parseResponse：text 块拼 content + tool_use → ToolCall + usage 映射', () => {
    const response = adapter.parseResponse({
      content: [
        { type: 'text', text: '结果' },
        { type: 'tool_use', id: 'tc1', name: 'students.get', input: { id: 's1' } },
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    expect(response.content).toBe('结果');
    expect(response.toolCalls).toEqual([{ id: 'tc1', name: 'students.get', args: { id: 's1' } }]);
    expect(response.usage).toEqual({ promptTokens: 20, completionTokens: 8 });
  });

  it('错误归一：Anthropic 错误信封提取', () => {
    expect(adapter.normalizeError(401, { error: { message: 'bad key' } }).kind).toBe('auth');
    expect(adapter.normalizeError(429, {}).kind).toBe('rate_limited');
  });
});

describe('createLlmProvider 端到端（mock fetch）', () => {
  it('openai provider：chat 返回 content 与 toolCalls；错误归一抛出 ProviderError', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = createLlmProvider(OPENAI_CONFIG, {
      dnsLookup: publicDns,
      allowedCidrs: [],
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if ((init.body as string).includes('工具')) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: '查询', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'students.get', arguments: '{"id":"s1"}' } }] } }],
          }), { status: 200 });
        }
        if ((init.body as string).includes('bad')) {
          return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '你好回复' } }] }), { status: 200 });
      }) as typeof fetch,
    });

    const reply = await provider.chat(
      [{ role: 'user', content: '调用工具' }],
      [{ name: 'students.get', description: '查询', parameters: {} }],
    );
    expect(reply.content).toBe('查询');
    expect(reply.toolCalls).toEqual([{ id: 'tc1', name: 'students.get', args: { id: 's1' } }]);
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.tools[0].function.name).toBe('students.get');

    await expect(provider.chat([{ role: 'user', content: 'bad key 触发认证错误' }], [])).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'auth',
      status: 401,
    });
  });

  it('anthropic provider：URL /v1/messages + anthropic-version 头', async () => {
    let capturedUrl = '';
    const provider = createLlmProvider(ANTHROPIC_CONFIG, {
      dnsLookup: publicDns,
      allowedCidrs: [],
      fetchImpl: (async (url: string, init: RequestInit) => {
        capturedUrl = url;
        expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Claude 回复' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }), { status: 200 });
      }) as typeof fetch,
    });
    const reply = await provider.chat([{ role: 'user', content: 'hi' }], []);
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(reply.content).toBe('Claude 回复');
  });

  it('超时 → ProviderError kind=timeout retryable', async () => {
    const provider = createLlmProvider(OPENAI_CONFIG, {
      timeoutMs: 10,
      dnsLookup: publicDns,
      allowedCidrs: [],
      fetchImpl: (async (_url: string, init: RequestInit) => {
        await new Promise((_resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => rejectPromise(new Error('timed out')), 100);
          (init.signal as AbortSignal).addEventListener('abort', () => {
            clearTimeout(timer);
            rejectPromise(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
          });
        });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await expect(provider.chat([{ role: 'user', content: '慢请求' }], [])).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
  });
});

describe('buildProviderPayload 入口', () => {
  it('openai 走 openai 适配器 + stripEmptyTools 生效', () => {
    const payload = buildProviderPayload('openai', chatRequest()) as Record<string, unknown>;
    expect(payload.model).toBe('test-model');
    expect('tools' in payload).toBe(false); // 空 tools 已剥除
  });
});
