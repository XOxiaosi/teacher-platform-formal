import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreRouteDependencies } from '../../../src/app/composition/core-route-dependencies.js';
import { createToolAiClientForMode } from '../../../src/app/tool-registration.js';
import { createRealDshTeachingRuntime } from '../../../src/app/teaching-runtime/real-dsh-runtime.js';

vi.mock('../../../src/app/teaching-runtime/real-dsh-runtime.js', () => ({
  createRealDshTeachingRuntime: vi.fn(() => ({ availability: 'ready', runtimeVersion: 'dsh-v1', run: vi.fn() })),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('explicit DSH gate stays independent of provider/legacy local-safe isolation', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('does not assemble DSH for switch %s even with a runtime path', (enabled) => {
    vi.stubEnv('DSH_RUNTIME_ENABLED', enabled);
    vi.stubEnv('DSH_RUNTIME_ROOT', '/synthetic/dsh');
    const dependencies = createCoreRouteDependencies({} as PrismaClient, { localSafeMode: true });
    expect(dependencies.teachingRuntimeWorker).toBeUndefined();
    expect(createRealDshTeachingRuntime).not.toHaveBeenCalled();
    expect(dependencies.provider).toBeUndefined();
  });

  it('default assembly still requires explicit DSH opt-in', () => {
    vi.stubEnv('DSH_RUNTIME_ENABLED', undefined);
    vi.stubEnv('DSH_RUNTIME_ROOT', '/synthetic/dsh');
    const dependencies = createCoreRouteDependencies({} as PrismaClient);
    expect(dependencies.teachingRuntimeWorker).toBeUndefined();
    expect(createRealDshTeachingRuntime).not.toHaveBeenCalled();
  });

  it('explicit local-safe DSH is available without provider reads or legacy network access', async () => {
    vi.stubEnv('DSH_RUNTIME_ENABLED', 'true');
    vi.stubEnv('DSH_RUNTIME_ROOT', '/synthetic/dsh');
    vi.stubEnv('DEEPSEEK_API_KEY_FILE', '/synthetic/credential.env');
    const providerRead = vi.fn(() => { throw new Error('provider access forbidden'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no real network'));
    const dependencies = createCoreRouteDependencies({ providerConfig: { findMany: providerRead } } as unknown as PrismaClient, { localSafeMode: true });
    expect(dependencies.teachingRuntimeWorker?.availability).toBe('ready');
    expect(createRealDshTeachingRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeRoot: '/synthetic/dsh', apiKeyFile: '/synthetic/credential.env',
    }));
    expect(dependencies.provider).toBeUndefined();
    expect(dependencies.providerConfig?.providerConfigService.capabilities()).toMatchObject({ runtimeEnabled: false, connectionTestEnabled: false });
    const legacy = createToolAiClientForMode({ localSafeMode: true });
    expect(await legacy.run({ taskType: 'intent_recognition', input: { text: 'synthetic' } })).toMatchObject({ ok: false });
    expect(providerRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enabled without a checkout remains unavailable', () => {
    vi.stubEnv('DSH_RUNTIME_ENABLED', 'true');
    vi.stubEnv('DSH_RUNTIME_ROOT', undefined);
    expect(createCoreRouteDependencies({} as PrismaClient, { localSafeMode: true }).teachingRuntimeWorker).toBeUndefined();
    expect(createRealDshTeachingRuntime).not.toHaveBeenCalled();
  });
});
