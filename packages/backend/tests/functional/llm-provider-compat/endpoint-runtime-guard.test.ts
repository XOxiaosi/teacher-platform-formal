import { describe, expect, it, vi } from 'vitest';
import { createLlmProvider } from '../../../src/shared/llm-provider-compat/index.js';
import { createOpenAiCompatAdapter } from '../../../src/shared/llm-provider-compat/openai-compat.js';
import { createAnthropicAdapter } from '../../../src/shared/llm-provider-compat/anthropic.js';
import { parseAllowedCidrs, type DnsLookup } from '../../../src/shared/ssrf/endpoint-guard.js';

const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

const OPENAI_CONFIG = {
  providerKind: 'openai' as const,
  providerName: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
};

describe('L2 运行时守卫：fetch 前拦截（契约 §3）', () => {
  it('字面 loopback baseUrl → ProviderError(provider_down, SAFETY_BLOCK)，mock fetch 零调用', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const provider = createLlmProvider(
      { ...OPENAI_CONFIG, baseUrl: 'http://127.0.0.1:9' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: publicDns, allowedCidrs: [] },
    );
    await expect(provider.chat([{ role: 'user', content: 'hi' }], [])).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'provider_down',
      status: 0,
      retryable: false,
      message: expect.stringContaining('SAFETY_BLOCK') as unknown as string,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hostname 解析到 loopback → 同上，fetch 零调用', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const loopbackDns: DnsLookup = async () => [{ address: '127.0.0.1' }];
    const provider = createLlmProvider(
      { ...OPENAI_CONFIG, baseUrl: 'http://api.internal' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: loopbackDns, allowedCidrs: [] },
    );
    await expect(provider.chat([{ role: 'user', content: 'hi' }], [])).rejects.toMatchObject({
      kind: 'provider_down',
      message: expect.stringContaining('SAFETY_BLOCK') as unknown as string,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('公开 host → fetch 调用、正常返回', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '你好回复' } }] }),
      { status: 200 },
    ));
    const provider = createLlmProvider(
      { ...OPENAI_CONFIG },
      { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: publicDns, allowedCidrs: [] },
    );
    const reply = await provider.chat([{ role: 'user', content: 'hi' }], []);
    expect(reply.content).toBe('你好回复');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('白名单 CIDR 内 LAN IP → fetch 调用（自建 vLLM 场景）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200 },
    ));
    const provider = createLlmProvider(
      { ...OPENAI_CONFIG, baseUrl: 'http://10.0.0.5:8000' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        dnsLookup: publicDns,
        allowedCidrs: parseAllowedCidrs('10.0.0.0/8').allowed,
      },
    );
    const reply = await provider.chat([{ role: 'user', content: 'hi' }], []);
    expect(reply.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('run() 同样被守卫拦截（run/chat 都经 request()）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const provider = createLlmProvider(
      { ...OPENAI_CONFIG, baseUrl: 'http://127.0.0.1:9' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: publicDns, allowedCidrs: [] },
    );
    await expect(provider.run({ taskType: 'intent_recognition', input: { text: 'x' } })).rejects.toMatchObject({
      kind: 'provider_down',
      message: expect.stringContaining('SAFETY_BLOCK') as unknown as string,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('L3 反射收口：normalizeError 消息截断/清洗（契约 §3）', () => {
  it('openai：含 \n 与控制字符的超长 message → ≤200 字符且无控制字符', () => {
    const adapter = createOpenAiCompatAdapter();
    const long = `line1\nline2\x1b[31m${'x'.repeat(300)}`;
    const error = adapter.normalizeError(500, { error: { message: long } });
    expect(error.kind).toBe('provider_down');
    expect(error.message.length).toBeLessThanOrEqual(200 + '厂商服务异常：'.length);
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(error.message).toContain('厂商服务异常：line1line2');
  });

  it('anthropic：同样收口', () => {
    const adapter = createAnthropicAdapter();
    const long = `a\nb\x00${'y'.repeat(300)}`;
    const error = adapter.normalizeError(429, { error: { message: long } });
    expect(error.kind).toBe('rate_limited');
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(error.message.length).toBeLessThanOrEqual(200 + '限流：'.length);
    expect(error.message).toContain('限流：ab');
  });
});
