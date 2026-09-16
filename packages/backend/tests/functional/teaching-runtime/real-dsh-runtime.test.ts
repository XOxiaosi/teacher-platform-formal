import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRealDshTeachingRuntime } from '../../../src/app/teaching-runtime/real-dsh-runtime.js';

describe('real DSH teaching runtime configuration gate', () => {
  it('stays unavailable when the fixed source tree or credential is absent', () => {
    const driver = createRealDshTeachingRuntime({ runtimeRoot: '/tmp/missing-dsh-runtime', apiKeyFile: '/tmp/missing-deepseek.env' });
    expect(driver.availability).toBe('unavailable');
  });

  it('reports ready only when the DSH AgentLoop source, host bridge, and key file exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'teacher-platform-dsh-'));
    const keyFile = join(root, 'deepseek.env');
    const hostScript = join(root, 'host.ts');
    try {
      await mkdir(join(root, 'packages/core/agent-loop/src'), { recursive: true });
      await mkdir(join(root, 'node_modules/tsx'), { recursive: true });
      await writeFile(join(root, 'packages/core/agent-loop/src/index.ts'), 'export default {}\n');
      await writeFile(join(root, 'node_modules/tsx/package.json'), '{"name":"tsx"}\n');
      await writeFile(hostScript, '');
      await writeFile(keyFile, 'DEEPSEEK_API_KEY=sk-test-value\n');
      const driver = createRealDshTeachingRuntime({ runtimeRoot: root, apiKeyFile: keyFile, hostScript });
      expect(driver.availability).toBe('ready');
      expect(driver.runtimeVersion).toBe('dsh-v1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
