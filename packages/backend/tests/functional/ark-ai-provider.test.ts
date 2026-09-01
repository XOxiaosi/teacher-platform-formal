import { describe, it, expect, vi, afterEach } from 'vitest';
import { createArkAiProvider } from '../../src/shared/ai-client/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ark ai provider', () => {
  it('调用 OpenAI 兼容 chat completions 并解析 JSON 内容', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"intent":"lesson_record","confidenceScore":0.92}' } }] }),
    } as Response);
    const provider = createArkAiProvider({ apiKey: 'test-key', baseUrl: 'https://example.com/api/coding/v3', model: 'doubao-seed-2.0-pro' });

    const result = await provider.run({ taskType: 'intent_recognition', input: { text: '张三今天讲了动量守恒' } });

    expect(result).toEqual({ intent: 'lesson_record', confidenceScore: 0.92 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/coding/v3/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer test-key' }),
      }),
    );
  });

  it('非 2xx 响应时抛出 provider 错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'invalid api key' } }),
    } as Response);
    const provider = createArkAiProvider({ apiKey: 'bad-key', baseUrl: 'https://example.com/api/coding/v3', model: 'doubao-seed-2.0-pro' });

    await expect(provider.run({ taskType: 'intent_recognition', input: { text: '测试' } })).rejects.toThrow('invalid api key');
  });
});
