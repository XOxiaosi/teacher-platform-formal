import { describe, expect, it } from 'vitest';
import { createAiClient, createFailClosedAiProvider } from '../../../src/shared/ai-client/index.js';

describe('local-safe AI provider', () => {
  it('fails closed instead of generating a synthetic response', async () => {
    const client = createAiClient({ provider: createFailClosedAiProvider() });

    const result = await client.run({
      taskType: 'intent_recognition',
      input: { text: '明天下午三点上课' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('本机安全模式') },
    });
  });
});
