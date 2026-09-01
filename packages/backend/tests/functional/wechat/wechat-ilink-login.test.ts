import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RateLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createSlidingWindowLimiter } from '../../../src/app/middleware/rate-limit.js';
import { createAuthRouter } from '../../../src/app/routes/auth.routes.js';
import { createAuthService } from '../../../src/features/auth/index.js';
import { createDatabaseTrustedClock } from '../../../src/shared/trusted-clock/index.js';
import {
  computeWechatSignature,
  createChannelIdentityService,
  createLoginStateStore,
  createWechatLoginRouter,
  WECHAT_PLATFORM,
  type ChannelIdentityService,
  type CodeExchanger,
  type LoginStateStore,
  type WechatIlinkConfig,
} from '../../../src/features/wechat/index.js';

const prisma = new PrismaClient();

const TOKEN = 'wechat-ilink-test-token';
const BASE_CONFIG: WechatIlinkConfig = {
  enabled: true,
  appid: 'test-appid',
  appSecret: 'test-secret',
  token: TOKEN,
  apiBaseUrl: 'https://ilinkai.weixin.qq.com',
  allowedIps: ['127.0.0.1'],
  stateTtlMs: 5 * 60 * 1000,
  timestampWindowMs: 5 * 60 * 1000,
  qrcodeRatePerMin: 200, // 默认放宽；限流单独用例注入小值
  callbackRatePerMin: 200,
  bindRatePerMin: 200,
  notifyRatePerMin: 200,
  maxTextLength: 1500,
  recoveryIntervalMs: 60_000,
  unboundMaxPendingMs: 24 * 60 * 60 * 1000,
  webhookTimeoutMs: 4000,
  maxStateKeys: 1000,
  botToken: 'test-bot-token',
  longPollTimeoutMs: 40_000,
  pollBackoffMs: [2000, 5000, 30_000],
  maxConsecutivePollFailures: 3,
  contextTokenTtlMs: 24 * 60 * 60 * 1000,
  outboundTimeoutMs: 15_000,
};

interface BuildAppOptions {
  config?: Partial<WechatIlinkConfig>;
  exchanger?: CodeExchanger;
  limiter?: RateLimiter;
  stateStore?: LoginStateStore;
  resolveRequestIp?: (req: express.Request) => string | null;
  nowMs?: () => number;
}

function fakeExchanger(externalUserId: string): CodeExchanger {
  return {
    async exchange(_input) {
      return {
        ok: true as const,
        value: { externalUserId, providerChannelId: `bot-${externalUserId}` },
      };
    },
  };
}

function buildApp(options: BuildAppOptions = {}) {
  const authService = createAuthService({ prisma, clock: createDatabaseTrustedClock(prisma) });
  const authRouter = createAuthRouter(authService);
  const identityService: ChannelIdentityService = createChannelIdentityService({ prisma });
  const stateStore = options.stateStore ?? createLoginStateStore({ ttlMs: 5 * 60 * 1000, sweepIntervalMs: 60_000 });
  const wechatRouter = createWechatLoginRouter({
    authService,
    channelIdentityService: identityService,
    stateStore,
    config: { ...BASE_CONFIG, ...options.config },
    limiter: options.limiter,
    codeExchanger: options.exchanger ?? fakeExchanger('wx-user-default'),
    resolveRequestIp: options.resolveRequestIp,
    nowMs: options.nowMs,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', authRouter);
  app.use('/api/v1', wechatRouter);
  return { app, identityService };
}

const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.channelIdentity.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

async function registerTeacher(app: express.Express): Promise<{ cookie: string; teacherId: string }> {
  const email = `wx-ilink-${randomBytes(6).toString('hex')}@example.com`;
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'password123', displayName: '微信绑定测试' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  const teacherId = res.body.data.teacher.id;
  createdTeacherIds.push(teacherId);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, teacherId };
}

function signedPayload(state: string, code: string, nowMsValue = Date.now()) {
  const timestamp = String(Math.floor(nowMsValue / 1000));
  const nonce = randomBytes(8).toString('hex');
  const signature = computeWechatSignature({ token: TOKEN, timestamp, nonce });
  return { state, code, timestamp, nonce, signature };
}

async function callback(app: express.Express, payload: Record<string, string>) {
  return request(app).post('/api/v1/auth/wechat/callback').send(payload);
}

describe('GET /api/v1/auth/wechat/qrcode', () => {
  it('生成一次性 state + 二维码内容占位 + expiresInMs；无 session → authenticated:false', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.state).toBe('string');
    expect(res.body.data.state.length).toBeGreaterThanOrEqual(32);
    expect(res.body.data.qrContent).toContain(encodeURIComponent(res.body.data.state));
    expect(res.body.data.expiresInMs).toBe(5 * 60 * 1000);
    expect(res.body.data.authenticated).toBe(false);
  });

  it('已登录 session → authenticated:true（state 关联 teacherId）', async () => {
    const { app } = buildApp();
    const { cookie } = await registerTeacher(app);
    const res = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
  });

  it('state 键数达上限 → 503（防内存耗尽）', async () => {
    const store = createLoginStateStore({ ttlMs: 60_000, maxKeys: 1, sweepIntervalMs: 60_000 });
    const { app } = buildApp({ stateStore: store });
    const first = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(first.status).toBe(200);
    const second = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(second.status).toBe(503);
    expect(second.body.ok).toBe(false);
  });
});

describe('POST /api/v1/auth/wechat/callback：验签 + 白名单 + 重放', () => {
  it('验签成功 → accepted:true（未登录：state 转 confirmed）', async () => {
    const { app } = buildApp({ exchanger: fakeExchanger('wx-verify-1') });
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-1');
    const res = await callback(app, payload);
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(true);
  });

  it('错误签名 → accepted:false（静默丢弃，不返回业务细节）', async () => {
    const { app } = buildApp();
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-bad');
    const res = await callback(app, { ...payload, signature: 'deadbeef' });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(false);
  });

  it('timestamp 超窗（±5min 外）→ accepted:false', async () => {
    const { app } = buildApp();
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const stale = signedPayload(qr.body.data.state, 'code-old', Date.now() - 10 * 60 * 1000);
    const res = await callback(app, stale);
    expect(res.body.data.accepted).toBe(false);
  });

  it('timestamp 非法（非数字/超长）→ accepted:false', async () => {
    const { app } = buildApp();
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-x');
    const res = await callback(app, { ...payload, timestamp: 'not-a-number' });
    expect(res.body.data.accepted).toBe(false);
  });

  it('重放：同 state+code+签名第二次 → accepted:false（state 状态机一次性）', async () => {
    const { app } = buildApp();
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-replay');
    const first = await callback(app, payload);
    expect(first.body.data.accepted).toBe(true);
    const second = await callback(app, payload);
    expect(second.body.data.accepted).toBe(false);
  });

  it('state 缺失/不存在/已消费 → accepted:false', async () => {
    const { app } = buildApp();
    const missing = await callback(app, signedPayload('no-such-state', 'code-missing'));
    expect(missing.body.data.accepted).toBe(false);
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const empty = await callback(app, { code: 'x' } as Record<string, string>);
    expect(empty.body.data.accepted).toBe(false);
    void qr;
  });

  it('IP 白名单：非白名单 IP → accepted:false（resolveRequestIp 注入）', async () => {
    const { app } = buildApp({ resolveRequestIp: () => '203.0.113.9' });
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-ip');
    const res = await callback(app, payload);
    expect(res.body.data.accepted).toBe(false);
  });

  it('IP 白名单：空白名单（未配置）→ fail-closed 全拒', async () => {
    const { app } = buildApp({ config: { allowedIps: [] }, resolveRequestIp: () => '127.0.0.1' });
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-fc');
    const res = await callback(app, payload);
    expect(res.body.data.accepted).toBe(false);
  });
});

describe('绑定决策树（三分支）', () => {
  it('分支 A：已登录 session → 回调直接绑 ChannelIdentity', async () => {
    const { app, identityService } = buildApp({ exchanger: fakeExchanger('wx-bound-a') });
    const { cookie, teacherId } = await registerTeacher(app);

    const qr = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    expect(qr.body.data.authenticated).toBe(true);
    const payload = signedPayload(qr.body.data.state, 'code-a');
    const res = await callback(app, payload);
    expect(res.body.data.accepted).toBe(true);

    const resolved = await identityService.resolveTeacherId({
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-bound-a',
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok ? resolved.value : null).toBe(teacherId);
  });

  it('分支 B：未登录扫码 → confirmed/needs_login → 现有登录后 bind 完成绑定', async () => {
    const { app, identityService } = buildApp({ exchanger: fakeExchanger('wx-bound-b') });
    const { cookie, teacherId } = await registerTeacher(app);

    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(qr.body.data.authenticated).toBe(false);
    const payload = signedPayload(qr.body.data.state, 'code-b');
    const cb = await callback(app, payload);
    expect(cb.body.data.accepted).toBe(true);

    const status = await request(app).get(`/api/v1/auth/wechat/login/status?state=${qr.body.data.state}`);
    expect(status.body.data.status).toBe('confirmed');
    expect(status.body.data.binding).toBe('needs_login');

    const bind = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', cookie)
      .send({ state: qr.body.data.state });
    expect(bind.status).toBe(200);
    expect(bind.body.data.bound).toBe(true);
    expect(bind.body.data.identity.externalUserId).toBe('wx-bound-b');

    const resolved = await identityService.resolveTeacherId({
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-bound-b',
    });
    expect(resolved.ok ? resolved.value : null).toBe(teacherId);

    // 绑定后轮询状态 → bound
    const after = await request(app).get(`/api/v1/auth/wechat/login/status?state=${qr.body.data.state}`);
    expect(after.body.data.status).toBe('bound');
  });

  it('分支 C：无账号（默认不自动注册）——扫码不产生教师账号，状态保持 needs_login', async () => {
    const { app } = buildApp();
    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    const payload = signedPayload(qr.body.data.state, 'code-c');
    const cb = await callback(app, payload);
    expect(cb.body.data.accepted).toBe(true);

    const status = await request(app).get(`/api/v1/auth/wechat/login/status?state=${qr.body.data.state}`);
    expect(status.body.data.status).toBe('confirmed');
    expect(status.body.data.binding).toBe('needs_login');

    // 未登录 bind → 401（requireAuth 兜底，不产生绑定/不自动注册教师账号）
    const bind = await request(app).post('/api/v1/auth/wechat/bind').send({ state: qr.body.data.state });
    expect(bind.status).toBe(401);
  });

  it('一微信号一 Agent：externalUserId 已绑 A，B 绑定同微信号 → 400', async () => {
    const { app } = buildApp({ exchanger: fakeExchanger('wx-shared') });
    const teacherA = await registerTeacher(app);
    const teacherB = await registerTeacher(app);

    // A 未登录扫码路径绑定 wx-shared
    const qrA = await request(app).get('/api/v1/auth/wechat/qrcode');
    await callback(app, signedPayload(qrA.body.data.state, 'code-a'));
    const bindA = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', teacherA.cookie)
      .send({ state: qrA.body.data.state });
    expect(bindA.status).toBe(200);

    // B 尝试绑定同一微信号（已登录直接回调路径）
    const qrB = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', teacherB.cookie);
    const cbB = await callback(app, signedPayload(qrB.body.data.state, 'code-b'));
    expect(cbB.body.data.accepted).toBe(false); // 绑定失败 → 静默丢弃
  });

  it('教师已绑定 → 再绑另一个微信号 → 回调静默拒绝 / bind 端点 400 请先解绑', async () => {
    // code → 不同 externalUserId（code-1 → wx-first，其余 → wx-second）
    const exchanger: CodeExchanger = {
      async exchange(input) {
        const id = input.code === 'code-1' ? 'wx-first' : 'wx-second';
        return { ok: true as const, value: { externalUserId: id, providerChannelId: `bot-${id}` } };
      },
    };
    const { app } = buildApp({ exchanger });
    const { cookie } = await registerTeacher(app);

    // 第一次扫码（code-1 → wx-first）→ 直接绑定成功
    const qr1 = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    const cb1 = await callback(app, signedPayload(qr1.body.data.state, 'code-1'));
    expect(cb1.body.data.accepted).toBe(true);

    // 第二次扫码另一个微信号（code-2 → wx-second）：已登录直接回调路径 → 绑定被拒（静默）
    const qr2 = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    const cb2 = await callback(app, signedPayload(qr2.body.data.state, 'code-2'));
    expect(cb2.body.data.accepted).toBe(false);

    // bind 端点路径（未登录扫码 → confirmed → 登录后 bind）：同一冲突 → 400「请先解绑」
    const qr3 = await request(app).get('/api/v1/auth/wechat/qrcode');
    const cb3 = await callback(app, signedPayload(qr3.body.data.state, 'code-3'));
    expect(cb3.body.data.accepted).toBe(true); // 未登录路径先确认（绑定在 bind 时校验）
    const bind = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', cookie)
      .send({ state: qr3.body.data.state });
    expect(bind.status).toBe(400);
    expect(bind.body.error.message).toBe('该教师已绑定微信，请先解绑');
  });

  it('解绑（ChannelIdentity 删除）→ resolveTeacherId null；幂等', async () => {
    const { app, identityService } = buildApp({ exchanger: fakeExchanger('wx-unbind') });
    const { cookie, teacherId } = await registerTeacher(app);

    const qr = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    await callback(app, signedPayload(qr.body.data.state, 'code-unbind'));
    const resolved = await identityService.resolveTeacherId({
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-unbind',
    });
    expect(resolved.ok ? resolved.value : null).toBe(teacherId);

    const unbind = await request(app).post('/api/v1/auth/wechat/unbind').set('Cookie', cookie);
    expect(unbind.status).toBe(200);
    expect(unbind.body.data.unbound).toBe(true);

    const after = await identityService.resolveTeacherId({
      platform: WECHAT_PLATFORM,
      externalUserId: 'wx-unbind',
    });
    expect(after.ok ? after.value : null).toBeNull();

    const unbindAgain = await request(app).post('/api/v1/auth/wechat/unbind').set('Cookie', cookie);
    expect(unbindAgain.status).toBe(200);
    expect(unbindAgain.body.data.unbound).toBe(false); // 幂等
  });
});

describe('state 一次性 / 过期', () => {
  it('已消费（bound）state 重复 bind → 409', async () => {
    const { app } = buildApp({ exchanger: fakeExchanger('wx-once') });
    const { cookie } = await registerTeacher(app);

    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    await callback(app, signedPayload(qr.body.data.state, 'code-once'));
    const bind = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', cookie)
      .send({ state: qr.body.data.state });
    expect(bind.status).toBe(200);

    const rebind = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', cookie)
      .send({ state: qr.body.data.state });
    expect(rebind.status).toBe(409);
    expect(rebind.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('state 过期（TTL 单调时钟推进）→ status expired；bind 拒绝', async () => {
    let fakeNow = 1_000_000;
    const store = createLoginStateStore({ ttlMs: 1000, nowMs: () => fakeNow, sweepIntervalMs: 60_000 });
    const { app } = buildApp({ stateStore: store, exchanger: fakeExchanger('wx-ttl') });
    const { cookie } = await registerTeacher(app);

    const qr = await request(app).get('/api/v1/auth/wechat/qrcode');
    await callback(app, signedPayload(qr.body.data.state, 'code-ttl'));

    fakeNow += 2000; // 超 TTL
    const status = await request(app).get(`/api/v1/auth/wechat/login/status?state=${qr.body.data.state}`);
    expect(status.body.data.status).toBe('expired');

    const bind = await request(app)
      .post('/api/v1/auth/wechat/bind')
      .set('Cookie', cookie)
      .send({ state: qr.body.data.state });
    expect(bind.status).toBe(409);
  });
});

describe('限流（复用 RateLimiter）', () => {
  it('扫码端点（qrcode+status 同键）：1min/2 → 第 3 次 429 + Retry-After + RATE_LIMITED', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    const { app } = buildApp({ config: { qrcodeRatePerMin: 2 }, limiter });

    const first = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(first.status).toBe(200);
    const second = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(second.status).toBe(200);
    const third = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', field: 'rate' },
    });
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('回调端点：1min/2 → 第 3 次 429（独立键 wechat:callback）', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    const { app } = buildApp({ config: { callbackRatePerMin: 2 }, limiter });

    const first = await callback(app, signedPayload('s1', 'c1'));
    expect(first.status).toBe(200);
    const second = await callback(app, signedPayload('s2', 'c2'));
    expect(second.status).toBe(200);
    const third = await callback(app, signedPayload('s3', 'c3'));
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('扫码与回调独立计数（不同键前缀）', async () => {
    const limiter = createSlidingWindowLimiter({ maxKeys: 1000 });
    const { app } = buildApp({ config: { qrcodeRatePerMin: 1, callbackRatePerMin: 2 }, limiter });

    // qrcode 打满 1 次
    await request(app).get('/api/v1/auth/wechat/qrcode');
    const qrBlocked = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(qrBlocked.status).toBe(429);
    // callback 仍可用（独立键）
    const cb = await callback(app, signedPayload('s-cb', 'c-cb'));
    expect(cb.status).toBe(200);
  });
});
