import { describe, it, expect, vi } from 'vitest';
import { createWechatBotAdapter } from '../../src/adapters/wechat-bot/index.js';
import { createWecomAdapter } from '../../src/adapters/wecom/index.js';
import { createTelegramAdapter } from '../../src/adapters/telegram/index.js';
import { createWeatherAdapter } from '../../src/adapters/weather/index.js';

describe('message adapters', () => {
  it('wechat-bot adapter 调用 transport.send', async () => {
    const send = vi.fn(async () => ({ messageId: 'wx-1' }));
    const adapter = createWechatBotAdapter({ transport: { send } });

    const result = await adapter.send({ to: 'teacher', content: '早安简报' });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith({ to: 'teacher', content: '早安简报' });
    if (!result.ok) return;
    expect(result.value.messageId).toBe('wx-1');
  });

  it('wecom adapter 调用 transport.send', async () => {
    const send = vi.fn(async () => ({ messageId: 'wecom-1' }));
    const adapter = createWecomAdapter({ transport: { send } });

    const result = await adapter.send({ to: 'user-1', content: '晚间复盘' });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith({ to: 'user-1', content: '晚间复盘' });
  });

  it('telegram adapter 调用 transport.send', async () => {
    const send = vi.fn(async () => ({ messageId: 'tg-1' }));
    const adapter = createTelegramAdapter({ transport: { send } });

    const result = await adapter.send({ to: 'chat-1', content: '提醒' });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith({ to: 'chat-1', content: '提醒' });
  });

  it('发送内容为空返回 VALIDATION_ERROR', async () => {
    const send = vi.fn(async () => ({ messageId: 'x' }));
    const adapter = createTelegramAdapter({ transport: { send } });

    const result = await adapter.send({ to: 'chat-1', content: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(send).not.toHaveBeenCalled();
  });

  it('transport 抛错返回 INTERNAL_ERROR', async () => {
    const send = vi.fn(async () => { throw new Error('network failed'); });
    const adapter = createWechatBotAdapter({ transport: { send } });

    const result = await adapter.send({ to: 'teacher', content: 'hello' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('weather adapter', () => {
  it('查询天气并返回标准结构', async () => {
    const query = vi.fn(async () => ({ city: '福州', weather: '晴', temperatureC: 30 }));
    const adapter = createWeatherAdapter({ transport: { query } });

    const result = await adapter.query({ city: '福州' });

    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledWith({ city: '福州' });
    if (!result.ok) return;
    expect(result.value.city).toBe('福州');
    expect(result.value.weather).toBe('晴');
  });

  it('城市为空返回 VALIDATION_ERROR', async () => {
    const query = vi.fn(async () => ({ city: '福州', weather: '晴', temperatureC: 30 }));
    const adapter = createWeatherAdapter({ transport: { query } });

    const result = await adapter.query({ city: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(query).not.toHaveBeenCalled();
  });
});
