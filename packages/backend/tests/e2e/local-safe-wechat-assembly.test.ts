import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/index.js';
import type { WechatRuntime } from '../../src/features/wechat/index.js';

const prisma = new PrismaClient();
const WECHAT_ENV = {
  WECHAT_ILINK_ENABLED: 'true',
  WECHAT_ILINK_APPID: 'local-safe-appid',
  WECHAT_ILINK_APPSECRET: 'local-safe-secret',
  WECHAT_ILINK_TOKEN: 'local-safe-token',
  WECHAT_ILINK_ALLOWED_IPS: '127.0.0.1',
} as const;
const savedEnv = new Map<string, string | undefined>();
const startedRuntimes: WechatRuntime[] = [];

beforeEach(() => {
  for (const [key, value] of Object.entries(WECHAT_ENV)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(async () => {
  await Promise.all(startedRuntimes.splice(0).map((runtime) => runtime.stop()));
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('L0 local-safe WeChat assembly', () => {
  it('默认 local-safe：即使 WECHAT_ILINK_ENABLED=true 也不挂载、不启动 runtime', async () => {
    let mounted = false;
    const app = createApp(prisma, {
      onWechatRuntime(runtime) {
        mounted = true;
        startedRuntimes.push(runtime);
      },
    });

    expect(mounted).toBe(false);
    expect((await request(app).get('/api/v1/auth/wechat/qrcode')).status).toBe(401);
  });

  it('只有显式 opt-out 才允许挂载 WeChat', async () => {
    let mounted = false;
    const app = createApp(prisma, {
      localSafeMode: false,
      onWechatRuntime(runtime) {
        mounted = true;
        startedRuntimes.push(runtime);
      },
    });

    expect(mounted).toBe(true);
    expect((await request(app).get('/api/v1/auth/wechat/qrcode')).status).toBe(200);
  });
});
