/** Invoke only the pinned upstream source and the explicit isolated A02 directory. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkoutArg, nodeArg] = process.argv.slice(2);
assert(checkoutArg && nodeArg, 'Usage: node scripts/dsh-runtime/run.mjs UPSTREAM_CHECKOUT COMPATIBLE_NODE');
const checkout = resolve(checkoutArg);
const runtimeNode = resolve(nodeArg);
const sha = 'c291e7961a515f6d7af9304e7fd1d257929aef26';
const current = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
assert.equal(current.status, 0);
assert.equal(current.stdout.trim(), sha, 'A02 refuses an unpinned DSH version');
const probe = join(checkout, '.a02-probe.ts');
copyFileSync(fileURLToPath(new URL('./probe.ts', import.meta.url)), probe);
const runRoot = join(checkout, '.a02', `run-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(runRoot, { recursive: true });
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') };
const modes = ['create', 'resume', 'lock', 'deny', 'isolation', 'failure', 'cancel', 'crash', 'resume-crash'];
const results = [];
for (const mode of modes) {
  const child = spawnSync(runtimeNode, ['--import', 'tsx/esm', probe, mode, runRoot], {
    cwd: checkout, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  writeFileSync(join(runRoot, `${mode}.log`), `${child.stdout ?? ''}${child.stderr ?? ''}`);
  const expectedCrash = mode === 'crash' && child.signal === 'SIGKILL' && child.stdout.includes('A02_FAULT');
  const passed = mode === 'crash' ? expectedCrash : child.status === 0;
  results.push({ mode, passed, exitCode: child.status, signal: child.signal });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${mode} exit=${child.status} signal=${child.signal ?? 'none'}`);
  if (!passed) {
    console.error(child.stderr || child.error || child.stdout);
    break;
  }
}
writeFileSync(join(runRoot, 'summary.json'), JSON.stringify({ sha, runtimeNode, runRoot, realUpstreamLoop: true, model: 'scripted-test-only', results }, null, 2));
console.log(`A02_EVIDENCE=${runRoot}`);
assert.equal(results.length, modes.length, 'all A02 cases must run');
assert(results.every(result => result.passed), 'A02 case failed');
