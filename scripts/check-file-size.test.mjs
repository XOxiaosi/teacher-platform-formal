import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('native paths match legacy hashes; private runtime files are ignored; changed source still fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpf-file-size-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages', 'fixture'), { recursive: true });
    mkdirSync(join(root, '.data', 'tools'), { recursive: true });
    copyFileSync(new URL('./check-file-size.mjs', import.meta.url), join(root, 'scripts', 'check-file-size.mjs'));
    const content = '// unchanged legacy source\n'.repeat(501);
    const source = join(root, 'packages', 'fixture', 'legacy.ts');
    writeFileSync(source, content);
    writeFileSync(join(root, '.data', 'tools', 'runtime.js'), '// generated\n'.repeat(900));
    writeFileSync(join(root, 'scripts', 'file-size-legacy-baseline.json'), JSON.stringify({
      sourceCommit: 'fixture', exitTask: 'fixture', files: {
        'packages/fixture/legacy.ts': {
          lines: 502, sha256: createHash('sha256').update(content).digest('hex'),
        },
      },
    }));
    const run = () => spawnSync(process.execPath, ['scripts/check-file-size.mjs'], { cwd: root, encoding: 'utf8' });
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /Unchanged legacy exceptions \(1,/);
    writeFileSync(source, content.replace('unchanged', 'modified'));
    const changed = run();
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /packages\/fixture\/legacy.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
