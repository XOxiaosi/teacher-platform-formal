import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkoutArg, nodeArg] = process.argv.slice(2);
assert(checkoutArg && nodeArg, 'Usage: node scripts/dsh-runtime/run-adapter.mjs PINNED_CHECKOUT COMPATIBLE_NODE');
const checkout = resolve(checkoutArg);
const runtimeNode = resolve(nodeArg);
const sha = 'c291e7961a515f6d7af9304e7fd1d257929aef26';
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
assert.equal(head.status, 0); assert.equal(head.stdout.trim(), sha, 'unverified DSH version');
const clean = spawnSync('git', ['diff', 'HEAD', '--quiet'], { cwd: checkout });
assert.equal(clean.status, 0, 'upstream tracked source differs from pinned version');
for (const [source, target] of [['teaching-host.ts', '.a02-teaching-host.ts'], ['adapter-probe.ts', '.a02-adapter-probe.ts']]) {
  copyFileSync(fileURLToPath(new URL(source, import.meta.url)), join(checkout, target));
}
const runRoot = join(checkout, '.a02', `adapter-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(runRoot, { recursive: true });
const driver = fileURLToPath(new URL('../../packages/backend/src/app/teaching-runtime/dsh-runtime-driver.ts', import.meta.url));
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') };
const modes = ['create', 'replay', 'next', 'replay-after-next', 'deny', 'recover-deny', 'replay-recovered-deny', 'isolation', 'failure', 'recover-failure', 'cancel'];
const results = [];
for (const mode of modes) {
  const child = spawnSync(runtimeNode, ['--import', 'tsx/esm', join(checkout, '.a02-adapter-probe.ts'), runRoot, driver, mode], {
    cwd: checkout, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  writeFileSync(join(runRoot, `${mode}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`);
  results.push({ mode, passed: child.status === 0, exitCode: child.status, signal: child.signal });
  console.log(`${child.status === 0 ? 'PASS' : 'FAIL'} ${mode}`);
  if (child.status !== 0) { console.error(child.stderr || child.error || child.stdout); break; }
}
writeFileSync(join(runRoot, 'summary.json'), JSON.stringify({ sha, runtimeNode, runRoot, model: 'scripted-test-only', results }, null, 2));
console.log(`A02_ADAPTER_EVIDENCE=${runRoot}`);
assert.equal(results.length, modes.length);
assert(results.every(result => result.passed));
