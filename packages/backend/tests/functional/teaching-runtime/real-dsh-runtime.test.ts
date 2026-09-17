import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealDshTeachingRuntime, DSH_PINNED_COMMIT } from '../../../src/app/teaching-runtime/real-dsh-runtime.js';

afterEach(() => vi.unstubAllEnvs());

describe('real DSH teaching runtime configuration gate', () => {
  it('stays unavailable when the fixed source tree or credential is absent', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const driver = createRealDshTeachingRuntime({ runtimeRoot: '/tmp/missing-dsh-runtime', apiKeyFile: '/tmp/missing-deepseek.env' });
    expect(driver.availability).toBe('unavailable');
  });

  it('reports ready only when the DSH AgentLoop source, host bridge, and key file exist', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const root = await mkdtemp(join(tmpdir(), 'teacher-platform-dsh-'));
    const keyFile = join(root, 'deepseek.env');
    const hostScript = join(root, 'host.ts');
    const sessionRoot = join(root, 'sessions');
    try {
      await mkdir(join(root, 'packages/core/agent-loop/src'), { recursive: true });
      await mkdir(join(root, 'node_modules/tsx'), { recursive: true });
      await writeFile(join(root, 'packages/core/agent-loop/src/index.ts'), 'export default {}\n');
      await writeFile(join(root, 'node_modules/tsx/package.json'), '{"name":"tsx"}\n');
      await writeFile(hostScript, '');
      await writeFile(keyFile, 'DEEPSEEK_API_KEY=sk-test-value\n');
      const options = { runtimeRoot: root, apiKeyFile: keyFile, hostScript, sessionRoot };
      const driver = createRealDshTeachingRuntime({ ...options, gitHeadReader: () => DSH_PINNED_COMMIT });
      expect(driver.availability).toBe('ready');
      expect(driver.runtimeVersion).toBe('dsh-v1');
      expect(createRealDshTeachingRuntime({ ...options, gitHeadReader: () => 'changed-commit' }).availability).toBe('unavailable');
      expect(createRealDshTeachingRuntime({ ...options, gitHeadReader: () => { throw new Error('no git'); } }).availability).toBe('unavailable');
      // The default reader actually invokes Git; a source-shaped directory
      // without repository metadata cannot pretend to be the pinned checkout.
      expect(createRealDshTeachingRuntime(options).availability).toBe('unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
