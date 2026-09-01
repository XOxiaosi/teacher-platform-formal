import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalError } from '@teacher-platform/contracts';
import {
  buildIlinkHeaders,
  createIlinkContextStore,
  createIlinkHttpClient,
  createIlinkLongPollDriver,
  createIlinkOutboundAdapter,
  deriveIlinkExternalMessageId,
  extractIlinkText,
  isAbortError,
  isIlinkSessionExpiredError,
  parseIlinkInboundMessage,
  randomWechatUin,
  sendIlinkTextMessage,
  ILINK_CHANNEL_VERSION,
  ILINK_MSG_STATE_FINISH,
  ILINK_MSG_TYPE_BOT,
  type IlinkHttpClient,
} from '../../../src/features/wechat/index.js';
import type { WechatProviderDriver } from '../../../src/features/wechat/types.js';

/**
 * P9 W0 契约测试（协议冻结 p9-w0-wechat-ilink-protocol-freeze.md，mock HTTP 层——注入 fetch）。
 *
 * 纪律：
 * - 真实凭证不进仓库/测试：所有测试用假 bot_token（'wx-bot-token'）经 fetchImpl mock，零真实调用；
 * - 覆盖：请求形状（URL/方法/头/JSON body）、响应解析（ret 语义/消息 ID）、错误归一
 *   （HTTP/业务 ret≠0/网络/超时 → CommonError 心智）、入站归一化（自发过滤/文本提取/幂等 ID）、
 *   长轮询语义（40s 超时续拉/cursor/退避/session 过期终止/stop 中断）；
 * - 时间纪律：driver 退避/超时用 vi.useFakeTimers；无 new Date/Date.now（业务时间纪律）。
 */

const BASE_URL = 'https://ilinkai.weixin.qq.com';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function httpErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: async () => text,
  };
}

/** 模拟真实 fetch 对 AbortSignal 的响应：abort → 拒绝 AbortError；否则永远挂起。 */
function hangingFetchAbortable(_url: string, init?: { signal?: AbortSignal }) {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true },
    );
  });
}

function makeClient(fetchImpl: typeof fetch, botToken = 'wx-bot-token'): IlinkHttpClient {
  return createIlinkHttpClient({ apiBaseUrl: BASE_URL, botToken, fetchImpl });
}

const DRIVER_CONFIG = {
  apiBaseUrl: BASE_URL,
  botToken: 'wx-bot-token',
  longPollTimeoutMs: 40_000,
  pollBackoffMs: [2000, 5000, 30_000],
  maxConsecutivePollFailures: 3,
};

describe('W0 契约：iLink HTTP client（请求形状/响应解析/错误归一）', () => {
  it('POST 请求形状：URL 拼接、方法、W0 冻结头（AuthorizationType/X-WECHAT-UIN/Bearer）、JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: 0 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/sendmessage', { msg: { hello: 1 } });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE_URL}/ilink/bot/sendmessage`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(init.headers['Authorization']).toBe('Bearer wx-bot-token');
    expect(typeof init.headers['X-WECHAT-UIN']).toBe('string');
    expect(init.headers['X-WECHAT-UIN'].length).toBeGreaterThan(0);
    expect(JSON.parse(init.body)).toEqual({ msg: { hello: 1 } });
  });

  it('请求头：无 bot_token 时不带 Authorization（登录端点形态，W0 冻结）', async () => {
    const headers = buildIlinkHeaders('');
    expect(headers.Authorization).toBeUndefined();
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    const withToken = buildIlinkHeaders('tok-1');
    expect(withToken.Authorization).toBe('Bearer tok-1');
  });

  it('randomWechatUin：uint32 → base64 非空串', () => {
    const uin = randomWechatUin();
    expect(typeof uin).toBe('string');
    expect(uin.length).toBeGreaterThan(0);
    expect(() => Buffer.from(uin, 'base64')).not.toThrow();
  });

  it('成功响应：ret=0 → ok(响应 JSON)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: 0, get_updates_buf: 'buf-1', msgs: [] }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/getupdates', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ ret: 0, get_updates_buf: 'buf-1' });
    }
  });

  it('HTTP 非 2xx → INTERNAL_ERROR（消息含端点 + 状态码，响应体截断防泄密）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpErrorResponse(500, 'internal boom'));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/getupdates', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('ilink/bot/getupdates HTTP 500');
    expect(result.error.message).toContain('internal boom');
  });

  it('业务错误：HTTP 200 但 ret≠0 → INTERNAL_ERROR（ret/errcode/errmsg 归一，W0 冻结）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: -1, errcode: 40001, errmsg: 'invalid token' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/getupdates', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('ret=-1');
    expect(result.error.message).toContain('errcode=40001');
    expect(result.error.message).toContain('errmsg=invalid token');
  });

  it('响应不是合法 JSON → INTERNAL_ERROR', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'not-json' });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/getupdates', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('不是合法 JSON');
  });

  it('网络错误（fetch reject）→ INTERNAL_ERROR（网络错误归一）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await client.post('ilink/bot/getupdates', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('网络错误');
  });

  it('超时（客户端 timer abort）→ 抛 AbortError（长轮询 40s 正常语义，调用方续拉）', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetchAbortable);
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const promise = client.post('ilink/bot/getupdates', {}, { timeoutMs: 50 });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  it('外部 signal 中止（driver stop 场景）→ 抛 AbortError', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetchAbortable);
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const controller = new AbortController();
    const promise = client.post('ilink/bot/getupdates', {}, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isIlinkSessionExpiredError：ret/errcode=-14 → true（W0 冻结），其它 → false', () => {
    expect(isIlinkSessionExpiredError(internalError('ilink/bot/getupdates ret=-14 errcode=-14 errmsg=session'))).toBe(true);
    expect(isIlinkSessionExpiredError(internalError('ilink/bot/getupdates errcode=-14'))).toBe(true);
    expect(isIlinkSessionExpiredError(internalError('ilink/bot/getupdates ret=-1 errcode=40001'))).toBe(false);
  });
});

describe('W0 契约：出站 sendmessage（reply/notify 共用）', () => {
  function seededStore(token = 'ctx-abc') {
    const store = createIlinkContextStore({ ttlMs: 24 * 60 * 60 * 1000 });
    store.set('wx-user-1', token);
    return store;
  }

  it('请求形状：msg（from="" / to / client_id uuid / message_type=2 / message_state=2 / item_list text）+ context_token + base_info', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: 0, msg_id: 'ilink-msg-9' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const adapter = createIlinkOutboundAdapter({ client, contextStore: seededStore() });

    const result = await adapter.send({ to: 'wx-user-1', content: '你好，今天的课表如下' });
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE_URL}/ilink/bot/sendmessage`);
    const body = JSON.parse(init.body);
    expect(body.base_info).toEqual({ channel_version: ILINK_CHANNEL_VERSION });
    expect(body.msg.from_user_id).toBe('');
    expect(body.msg.to_user_id).toBe('wx-user-1');
    expect(body.msg.message_type).toBe(ILINK_MSG_TYPE_BOT);
    expect(body.msg.message_state).toBe(ILINK_MSG_STATE_FINISH);
    expect(body.msg.context_token).toBe('ctx-abc');
    expect(body.msg.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: '你好，今天的课表如下' } }]);
  });

  it('成功解析：供应商 msg_id → messageId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: 0, msg_id: 'ilink-msg-9' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const adapter = createIlinkOutboundAdapter({ client, contextStore: seededStore() });
    const result = await adapter.send({ to: 'wx-user-1', content: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe('ilink-msg-9');
  });

  it('供应商未返回消息 ID → client_id 兜底（确定性幂等辅助）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: 0 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const adapter = createIlinkOutboundAdapter({ client, contextStore: seededStore() });
    const result = await adapter.send({ to: 'wx-user-1', content: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(result.value.messageId).toBe(body.msg.client_id);
    }
  });

  it('缺少 context_token（对方最近未发消息）→ VALIDATION_ERROR（iLink 回复前置条件）', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const adapter = createIlinkOutboundAdapter({ client, contextStore: createIlinkContextStore({ ttlMs: 1000 }) });
    const result = await adapter.send({ to: 'wx-user-2', content: 'hi' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('to');
    expect(result.error.message).toContain('context_token');
    expect(fetchMock).not.toHaveBeenCalled(); // fail-closed：不发请求
  });

  it('入参校验：空 to / 空 content → VALIDATION_ERROR（不发请求）', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const adapter = createIlinkOutboundAdapter({ client, contextStore: seededStore() });
    expect((await adapter.send({ to: '', content: 'hi' })).ok).toBe(false);
    expect((await adapter.send({ to: 'wx-user-1', content: '  ' })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('业务错误透传：ret≠0 → INTERNAL_ERROR（sendIlinkTextMessage 直测错误归一）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ret: -1, errcode: 40001, errmsg: 'invalid token' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const result = await sendIlinkTextMessage(
      { client, contextStore: seededStore() },
      { to: 'wx-user-1', content: 'hi' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(result.error.message).toContain('ret=-1');
  });
});

describe('W0 契约：入站归一化（parseIlinkInboundMessage / 文本提取 / 幂等 ID）', () => {
  it('文本消息 → NormalizedInboundMessage（externalMessageId/from/to/私聊/文本/replyContext）', () => {
    const message = parseIlinkInboundMessage({
      from_user_id: 'wx-user-1',
      to_user_id: 'wx-bot-1',
      msg_id: 'msg-1',
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '今天有课吗' } }],
    });
    expect(message).toEqual({
      channel: 'wechat',
      externalMessageId: 'msg-1',
      fromExternalUserId: 'wx-user-1',
      toExternalUserId: 'wx-bot-1',
      conversationType: 'private',
      messageType: 'text',
      text: '今天有课吗',
      replyContext: { contextToken: 'ctx-1' },
    });
  });

  it('自发消息过滤：from_user_id 以 @im.bot 结尾 → null（不循环）', () => {
    expect(
      parseIlinkInboundMessage({
        from_user_id: 'wx-bot-1@im.bot',
        msg_id: 'm1',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }),
    ).toBeNull();
  });

  it('无文本（仅图片/文件/视频，S3 媒体线）→ null（W0 只处理文本）', () => {
    expect(
      parseIlinkInboundMessage({
        from_user_id: 'wx-user-1',
        msg_id: 'm2',
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'x' } } }],
      }),
    ).toBeNull();
  });

  it('语音转文字（voice_item.text）→ 提取为文本（openhanako extractText 同款）', () => {
    expect(
      extractIlinkText([{ type: 3, voice_item: { text: '语音转文字内容' } }]),
    ).toBe('语音转文字内容');
    const message = parseIlinkInboundMessage({
      from_user_id: 'wx-user-1',
      msg_id: 'm3',
      item_list: [{ type: 3, voice_item: { text: '语音转文字内容' } }],
    });
    expect(message?.text).toBe('语音转文字内容');
  });

  it('externalMessageId 派生：msg_id 优先；缺省 → 确定性 sha256 哈希（同内容同 ID，异内容异 ID）', () => {
    const raw = (text: string) => ({ from_user_id: 'u1', item_list: [{ type: 1, text_item: { text } }] });
    const a = parseIlinkInboundMessage(raw('hi'));
    const b = parseIlinkInboundMessage(raw('hi'));
    const c = parseIlinkInboundMessage(raw('bye'));
    expect(a?.externalMessageId).toBe(b?.externalMessageId);
    expect(a?.externalMessageId).toMatch(/^[0-9a-f]{32}$/);
    expect(c?.externalMessageId).not.toBe(a?.externalMessageId);
    expect(deriveIlinkExternalMessageId({})).toBeUndefined(); // 无稳定 ID 且无可哈希种子 → undefined
  });

  it('context store：TTL 内命中、过期清除（单调时钟注入，无墙钟）', () => {
    let now = 1_000_000;
    const store = createIlinkContextStore({ ttlMs: 1000, nowMs: () => now });
    store.set('wx-chat-1', 'tok-1');
    expect(store.size()).toBe(1);
    expect(store.get('wx-chat-1')).toBe('tok-1');
    now += 500;
    expect(store.get('wx-chat-1')).toBe('tok-1');
    now += 600; // 过期
    expect(store.get('wx-chat-1')).toBeNull();
    expect(store.size()).toBe(0);
    store.set('wx-chat-2', 'tok-2');
    store.sweep();
    expect(store.size()).toBe(1);
  });
});

describe('W0 契约：入站长轮询 driver（40s 语义/cursor/退避/session 过期/stop）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDriver(client: IlinkHttpClient, contextStore = createIlinkContextStore({ ttlMs: 86_400_000 })) {
    return createIlinkLongPollDriver({ config: DRIVER_CONFIG, client, contextStore });
  }

  async function statusOf(driver: WechatProviderDriver): Promise<string> {
    const result = await driver.getStatus();
    return result.ok ? (result.value as string) : 'unknown';
  }

  it('start：缺 bot_token → fail-closed 错误（凭证纪律：不启动不发请求）', async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock as unknown as typeof fetch, '');
    const driver = createIlinkLongPollDriver({
      config: { ...DRIVER_CONFIG, botToken: '' },
      client,
      contextStore: createIlinkContextStore({ ttlMs: 1000 }),
    });
    const result = await driver.start(() => Promise.resolve());
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('start 重复调用 → 错误（单实例单循环）', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetchAbortable);
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client);
    expect((await driver.start(() => Promise.resolve())).ok).toBe(true);
    const second = await driver.start(() => Promise.resolve());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('INTERNAL_ERROR');
    await driver.stop();
  });

  it('getupdates 请求形状 + 消息投递（归一化）+ context_token 捕获 + cursor 回传', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ret: 0,
          get_updates_buf: 'buf-2',
          msgs: [
            {
              from_user_id: 'wx-user-1',
              to_user_id: 'wx-bot-1',
              msg_id: 'm1',
              context_token: 'ctx-1',
              item_list: [{ type: 1, text_item: { text: '你好' } }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ret: 0, get_updates_buf: 'buf-3', msgs: [] }))
      .mockImplementation(hangingFetchAbortable); // 后续轮挂起防循环
    const contextStore = createIlinkContextStore({ ttlMs: 86_400_000 });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client, contextStore);
    const onMessage = vi.fn();

    await driver.start(onMessage);
    // 等三轮稳定：call1（含消息）完成 → call2 完成 → call3 挂起
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // 请求形状（第一轮）：空 cursor + channel_version
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE_URL}/ilink/bot/getupdates`);
    const body1 = JSON.parse(init.body);
    expect(body1.get_updates_buf).toBe('');
    expect(body1.base_info).toEqual({ channel_version: ILINK_CHANNEL_VERSION });

    // cursor 随响应推进：call2 带 buf-2、call3 带 buf-3
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).get_updates_buf).toBe('buf-2');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).get_updates_buf).toBe('buf-3');

    // 消息投递（已归一化）
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'wechat',
        externalMessageId: 'm1',
        fromExternalUserId: 'wx-user-1',
        text: '你好',
        conversationType: 'private',
      }),
    );

    // context_token 捕获（出站回复前置条件）+ 状态 connected
    expect(contextStore.get('wx-user-1')).toBe('ctx-1');
    expect(await statusOf(driver)).toBe('connected');

    await driver.stop();
  });

  it('长轮询 40s 超时（AbortError）→ 正常续拉，状态保持 connected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ret: 0, get_updates_buf: 'b1', msgs: [] }))
      .mockImplementationOnce(hangingFetchAbortable) // call2 挂起到 40s 超时
      .mockResolvedValueOnce(jsonResponse({ ret: 0, get_updates_buf: 'b2', msgs: [] }))
      .mockImplementation(hangingFetchAbortable); // call4+ 挂起
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client);

    await driver.start(() => Promise.resolve());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // call1 完成 + call2 在途
    expect(await statusOf(driver)).toBe('connected');

    await vi.advanceTimersByTimeAsync(40_000); // call2 40s 超时 → abort → 续拉 call3 → call4 挂起
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    // cursor 语义：超时的 call2 未返回响应 → call3 仍带旧 cursor 'b1'；call3 响应后 → call4 带 'b2'
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).get_updates_buf).toBe('b1');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).get_updates_buf).toBe('b2');
    expect(await statusOf(driver)).toBe('connected'); // 超时不报错

    await driver.stop();
  });

  it('连续失败退避 [2000,5000,30000]：达 3 次 → 状态 error，但继续退避重试（不终止）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client);

    await driver.start(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(1); // 第 1 次失败 + 调度 2000ms 退避
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // 第 2 次失败
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000); // 第 3 次失败 → error
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await statusOf(driver)).toBe('error');

    await vi.advanceTimersByTimeAsync(30_000); // 继续重试（仅 session 过期终止）
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await driver.stop();
  });

  it('session 过期（ret=-14）→ 状态 error 且终止轮询（不可恢复，等重新扫码）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ret: -14, errcode: -14, errmsg: 'session expired' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client);

    await driver.start(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await statusOf(driver)).toBe('error');

    // 不再重试：推进大量时间后 fetch 调用数不变
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await driver.stop();
  });

  it('stop()：中止在途请求、状态 stopped、循环退出', async () => {
    const fetchMock = vi.fn().mockImplementation(hangingFetchAbortable);
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const driver = makeDriver(client);

    await driver.start(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(1);
    expect(await statusOf(driver)).toBe('connecting');

    await driver.stop();
    expect(await statusOf(driver)).toBe('stopped');

    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 循环已退出，不再拉取

    // stop 幂等
    await driver.stop();
    expect(await statusOf(driver)).toBe('stopped');
  });
});
