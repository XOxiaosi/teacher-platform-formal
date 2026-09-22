import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/index.js';
import { createCoreRouteDependencies } from '../../../src/app/composition/core-route-dependencies.js';
import { createToolAiClientForMode } from '../../../src/app/tool-registration.js';
import { runAsTeacher, type ProviderRouter } from '../../../src/shared/ai-client/index.js';

const originalCwd = process.cwd();
const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  vi.restoreAllMocks();
});

describe.sequential('L0 local-safe provider isolation', () => {
  it('不读取诱饵 .env，且即使传入教师 resolver 也不会解析 provider 或发起网络请求', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'teacher-platform-local-safe-'));
    const decoyKey = 'LOCAL_SAFE_TEST_DECOY';
    const resolver = {
      resolve: vi.fn(async () => {
        throw new Error('local-safe must not resolve a teacher provider');
      }),
      clearCache: vi.fn(),
    } as unknown as ProviderRouter;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('local-safe isolation test blocks all outbound fetch'),
    );

    try {
      await writeFile(join(fixtureDir, '.env'), `${decoyKey}=must-not-be-imported\nARK_API_KEY=decoy\n`);
      delete process.env[decoyKey];
      process.chdir(fixtureDir);

      const client = createToolAiClientForMode({
        localSafeMode: true,
        providerRouter: resolver,
      });
      const result = await runAsTeacher('teacher-with-real-provider-config', () => client.run({
        taskType: 'intent_recognition',
        input: { text: '测试本机安全模式' },
      }));

      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('本机安全模式') },
      });
      expect(process.env[decoyKey]).toBeUndefined();
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('完整 createApp 装配不读取 provider 配置；不挂 runtime/usage，但装配静态配置管理', async () => {
    const providerFindMany = vi.fn(async () => {
      throw new Error('local-safe must not read provider configuration');
    });
    const prisma = {
      providerConfig: { findMany: providerFindMany },
    } as unknown as PrismaClient;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('local-safe assembly test blocks all outbound fetch'),
    );
    setEnv('ADMIN_EMAIL', 'decoy-admin@example.com');
    setEnv('ADMIN_PASSWORD_HASH', 'scrypt$decoy$decoy');

    const dependencies = createCoreRouteDependencies(prisma, { localSafeMode: true });
    const app = createApp(prisma, { localSafeMode: true });

    expect(dependencies.provider).toBeUndefined();
    expect(dependencies.providerConfig?.providerConfigService.capabilities()).toEqual({
      configurationEnabled: true,
      runtimeEnabled: false,
      connectionTestEnabled: false,
      endpointValidation: 'static',
    });
    // x-teacher-id 让请求越过 coreGuard：若任一路由仍被挂载，会得到其自身鉴权/业务响应而非 404。
    expect((await request(app).get('/api/v1/admin/teachers').set('x-teacher-id', 'teacher-safe')).status).toBe(404);
    expect((await request(app).get('/api/v1/usage/summary').set('x-teacher-id', 'teacher-safe')).status).toBe(404);
    expect(providerFindMany).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
