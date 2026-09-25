import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectedPlatformAI } from './connected-platform-ai.mjs';

test('platform AI opts in without changing the persistent database or reading the credential', () => {
  const base = mkdtempSync(join(tmpdir(), 'tpf-platform-ai-'));
  try {
    const project = join(base, 'project'), data = join(base, 'data'), runtime = join(base, 'runtime');
    for (const directory of [project, data, runtime]) mkdirSync(directory);
    const key = join(data, 'platform.env');
    writeFileSync(key, 'synthetic-not-a-real-key');
    assert.deepEqual(connectedPlatformAI(data, project), {});
    const config = join(data, 'platform-ai.json');
    const save = value => writeFileSync(config, JSON.stringify(value));
    save({ runtimeRoot: runtime, apiKeyFile: key });
    assert.deepEqual(connectedPlatformAI(data, project), {
      DSH_RUNTIME_ENABLED: 'true', DSH_RUNTIME_ROOT: realpathSync(runtime),
      DSH_SESSION_ROOT: join(realpathSync(data), 'dsh-sessions'), DEEPSEEK_API_KEY_FILE: realpathSync(key),
    });
    for (const invalid of [null, [], {}, {runtimeRoot:'relative',apiKeyFile:key},
      {runtimeRoot:runtime,apiKeyFile:key,apiKey:'must-not-accept'},
      {runtimeRoot:project,apiKeyFile:key}, {runtimeRoot:runtime,apiKeyFile:data}]) {
      save(invalid); assert.throws(() => connectedPlatformAI(data, project));
    }
    for (const directory of [project, runtime]) {
      const embedded = join(directory, 'key.env'); writeFileSync(embedded, 'synthetic');
      save({ runtimeRoot: runtime, apiKeyFile: embedded });
      assert.throws(() => connectedPlatformAI(data, project));
    }
  } finally { rmSync(base, {recursive:true,force:true}); }
});
