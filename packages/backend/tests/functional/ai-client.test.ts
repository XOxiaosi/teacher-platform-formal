import { describe, it, expect } from 'vitest';
import { createAiClient } from '../../src/shared/ai-client/index.js';
import type { AiProvider } from '../../src/shared/ai-client/index.js';

const provider: AiProvider = {
  async run(task) {
    if (task.taskType === 'speech_to_text') return { text: '明天下午三点给张三上课' };
    if (task.taskType === 'intent_recognition') return { intent: 'create_schedule', confidence: 0.91 };
    return { studentName: '张三', timeText: '明天下午三点' };
  },
};

describe('aiClient.run', () => {
  it('调用 provider 并返回统一 Result', async () => {
    const client = createAiClient({ provider });
    const result = await client.run({ taskType: 'speech_to_text', input: { audioFilePath: '/tmp/a.m4a' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('明天下午三点给张三上课');
  });

  it('支持意图识别任务', async () => {
    const client = createAiClient({ provider });
    const result = await client.run({ taskType: 'intent_recognition', input: { text: '取消周四的课' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toBe('create_schedule');
    expect(result.value.confidence).toBe(0.91);
  });

  it('空 input 返回 VALIDATION_ERROR', async () => {
    const client = createAiClient({ provider });
    const result = await client.run({ taskType: 'information_extraction', input: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('input');
  });

  it('provider 抛错时返回 INTERNAL_ERROR', async () => {
    const failingProvider: AiProvider = {
      async run() {
        throw new Error('network failed');
      },
    };
    const client = createAiClient({ provider: failingProvider });
    const result = await client.run({ taskType: 'speech_to_text', input: { audioFilePath: '/tmp/a.m4a' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('AI 调用失败');
  });
});
