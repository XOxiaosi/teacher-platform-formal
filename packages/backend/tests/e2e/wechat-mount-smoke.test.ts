import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { computeWechatSignature } from '../../src/features/wechat/index.js';

/**
 * P8 t20 装配接线 smoke：
 * - 未启用（env 缺省）→ wechat 路由 404（零破坏，同 admin 先例）；
 * - 启用（WECHAT_ILINK_ENABLED=true + 关键 env）→ /api/v1/auth/wechat/qrcode|callback 与
 *   /api/v1/wechat/message 挂载可达（真实 HTTP）；入站消息经队列 worker 处理（未绑定挂起）；
 * - 优雅退出含 wechat：runtime.stop() 后队列拒绝入队；进程级（spawn 真实入口 + SHUTDOWN_PROBE_MS）
 *   优雅退出含 wechat 组件（exit 0）。
 */

const prisma = new PrismaClient();
const createdTeacherIds: string[] = [];

const WECHAT_ENV: Record<string, string> = {
  WECHAT_ILINK_ENABLED: 'true',
  WECHAT_ILINK_APPID: 'smoke-appid',
  WECHAT_ILINK_APPSECRET: 'smoke-secret',
  WECHAT_ILINK_TOKEN: 'smoke-token',
  WECHAT_ILINK_ALLOWED_IPS: '127.0.0.1',
};

const savedEnv = new Map<string, string | undefined>();

function setWechatEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}

function clearWechatEnv(): void {
  for (const key of Object.keys(WECHAT_ENV)) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  await prisma.channelMessage.deleteMany({});
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

function signedMessageFields(): { timestamp: string; nonce: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const signature = computeWechatSignature({ token: 'smoke-token', timestamp, nonce });
  return { timestamp, nonce, signature };
}

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalMessageId: `smoke-${randomBytes(6).toString('hex')}`,
    fromExternalUserId: 'wx-smoke-unbound',
    conversationType: 'private',
    messageType: 'text',
    text: 'smoke 消息',
    ...signedMessageFields(),
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

describe('装配：未启用（env 缺省）零破坏', () => {
  it('wechat 路由未挂载 → 有效 session 下 qrcode/message 404；业务路由正常', async () => {
    clearWechatEnv();
    const app = createApp(prisma);

    // 注册教师拿 session cookie（wechat 未启用不影响认证路由）
    const email = `smoke-disabled-${randomBytes(6).toString('hex')}@example.com`;
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', displayName: 'smoke' });
    expect(reg.status).toBe(201);
    const cookie = reg.headers['set-cookie'][0].split(';')[0];
    createdTeacherIds.push(reg.body.data.teacher.id);

    // 有效 session 下未挂载路径 → 404（无 session 时会被 coreGuard 401 拦截，此处用 session 精确断言未挂载）
    const qrcode = await request(app).get('/api/v1/auth/wechat/qrcode').set('Cookie', cookie);
    expect(qrcode.status).toBe(404);
    const message = await request(app)
      .post('/api/v1/wechat/message')
      .set('Cookie', cookie)
      .send(messageBody());
    expect(message.status).toBe(404);
  });
});

describe('装配：启用（WECHAT_ILINK_ENABLED=true）挂载可达', () => {
  it('qrcode/callback/message 端点真实 HTTP 可达', async () => {
    setWechatEnv(WECHAT_ENV);
    const app = createApp(prisma, { localSafeMode: false });

    // qrcode → 200 state 签发
    const qrcode = await request(app).get('/api/v1/auth/wechat/qrcode');
    expect(qrcode.status).toBe(200);
    expect(qrcode.body.ok).toBe(true);
    expect(typeof qrcode.body.data.state).toBe('string');
    expect(qrcode.body.data.qrContent).toContain(encodeURIComponent(qrcode.body.data.state));

    // callback（W0 code 交换未接 → accepted:false 静默；端点可达 200）
    const callback = await request(app)
      .post('/api/v1/auth/wechat/callback')
      .send({ state: qrcode.body.data.state, code: 'smoke-code', ...signedMessageFields() });
    expect(callback.status).toBe(200);
    expect(callback.body.data.accepted).toBe(false);

    // message（验签 + IP 白名单）→ accepted（未绑定：入队后 worker 挂起）
    const body = messageBody();
    const message = await request(app).post('/api/v1/wechat/message').send(body);
    expect(message.status).toBe(200);
    expect(message.body.data.accepted).toBe(true);
    expect(message.body.data.duplicate).toBe(false);

    // 队列 worker（runtime.start 已启动）处理 → 未绑定 → status=new 挂起
    const processed = await waitFor(async () => {
      const row = await prisma.channelMessage.findUnique({
        where: { channel_externalMessageId: { channel: 'wechat', externalMessageId: body.externalMessageId as string } },
      });
      return row !== null && row.status === 'new';
    });
    expect(processed).toBe(true);
    const row = await prisma.channelMessage.findUnique({
      where: { channel_externalMessageId: { channel: 'wechat', externalMessageId: body.externalMessageId as string } },
    });
    expect(row!.status).toBe('new'); // 未绑定挂起（不触发 Agent）
    expect(row!.teacherId).toBeNull();
  });

  it('优雅退出含 wechat：runtime.stop() 后队列拒绝入队（webhook 503）', async () => {
    setWechatEnv(WECHAT_ENV);
    let runtime: { stop(): Promise<void> } | null = null;
    const app = createApp(prisma, {
      localSafeMode: false,
      onWechatRuntime: (r) => {
        runtime = r;
      },
    });
    expect(runtime).not.toBeNull();

    await runtime!.stop();

    const message = await request(app).post('/api/v1/wechat/message').send(messageBody());
    expect(message.status).toBe(503); // 队列已停止：入队失败 → 503（幂等兜底，供应商重试）
  });
});

describe('进程级 smoke（真实入口 + 优雅退出含 wechat 组件）', () => {
  it('spawn 生产入口（wechat 启用 + SHUTDOWN_PROBE_MS）→ qrcode 可达 → 优雅退出 exit 0', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        LISTEN_HOST: '127.0.0.1',
        ACTION_TOKEN_SECRET: 'wechat-mount-smoke-secret-0123456789abcdef',
        SHUTDOWN_TIMEOUT_MS: '2000',
        SHUTDOWN_PROBE_MS: '1500',
        LOCAL_SAFE_MODE: 'false',
        ...WECHAT_ENV,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    try {
      // 等待健康 + qrcode 可达
      const base = `http://127.0.0.1:${port}`;
      const healthy = await waitForHttp(() => fetch(`${base}/api/v1/health/live`, { signal: AbortSignal.timeout(500) }), 10_000);
      expect(healthy).toBe(true);

      const qrcode = await fetch(`${base}/api/v1/auth/wechat/qrcode`);
      expect(qrcode.status).toBe(200);
      const payload = await qrcode.json() as { ok?: boolean; data?: { state?: string } };
      expect(payload.ok).toBe(true);
      expect(typeof payload.data?.state).toBe('string');

      // SHUTDOWN_PROBE_MS 触发优雅退出（含 wechat runtime.stop 钩子）→ exit 0
      const exitCode = await waitForExit(child, 10_000);
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
    void stderr;
  });
});

// ── 进程辅助（与 process-guard 同款）──────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(fetchFn: () => Promise<Response>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchFn();
      if (response.ok) return true;
    } catch {
      // 未就绪重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
