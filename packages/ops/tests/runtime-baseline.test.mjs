import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const opsRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = resolve(opsRoot, '../..');

function readText(relativePath) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test('M0 runtime baseline：Node 与 npm 使用机器可读的精确声明', () => {
  const rootPackage = readJson('package.json');
  const lockfile = readJson('package-lock.json');

  assert.equal(rootPackage.engines.node, '>=22.13.0 <23');
  assert.equal(rootPackage.engines.npm, '10.9.2');
  assert.equal(rootPackage.packageManager, 'npm@10.9.2');
  assert.equal(lockfile.packages[''].engines.node, '>=22.13.0 <23');
  assert.equal(lockfile.packages[''].engines.npm, '10.9.2');
});

test('M0 runtime baseline：PostgreSQL 17 与 PowerShell 7.4+ 有单一机器可读基线', () => {
  const baselinePath = resolve(projectRoot, 'deploy/runtime-baseline.json');
  assert.equal(existsSync(baselinePath), true, '缺少 deploy/runtime-baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  assert.deepEqual(baseline, {
    node: '>=22.13.0 <23',
    npm: '10.9.2',
    postgresql: '17',
    powershell: '>=7.4.0',
  });
});

test('M0 runtime baseline：CI 与部署手册不回退版本声明', () => {
  const workflow = readText('.github/workflows/ci.yml');
  const deploy = readText('deploy/DEPLOY.md');
  const ci = readText('deploy/CI.md');
  const windowsManual = readText('deploy/windows/README.md');

  assert.match(workflow, /node-version:\s*['"]22\.16\.0['"]/);
  assert.match(workflow, /image:\s*postgres:17\b/);
  assert.match(workflow, /\$PSVersionTable\.PSVersion\s+-lt\s+\[version\]'7\.4\.0'/);
  assert.doesNotMatch(workflow, /shell:\s*powershell\b/);
  assert.match(deploy, /Node\.js\s*\|\s*>= 22\.13\.0/);
  assert.match(deploy, /npm 10\.9\.2/);
  assert.match(deploy, /PostgreSQL\s*\|\s*17\b/);
  assert.match(deploy, /PowerShell\s*\|\s*>= 7\.4\.0/);
  assert.match(ci, /Node\.js >=22\.13\.0 且 <23/);
  assert.match(ci, /setup-node` 固定 22\.16\.0，内置 npm 10\.9\.2/);
  assert.doesNotMatch(ci, /固定 22\.12/);
  assert.match(ci, /PowerShell 7\.4\+/);
  assert.match(windowsManual, /Node\.js 22\.16\.0/);
  assert.match(windowsManual, /npm 10\.9\.2/);
  assert.match(windowsManual, /6 high \/ 0 critical/);
  assert.match(windowsManual, /不得称“零漏洞”或生产可用/);
});

test('M0 ops baseline：root test 与 gate 都会执行原始 ops runner', () => {
  const rootPackage = readJson('package.json');
  const gate = readText('scripts/gate.mjs');
  const regressions = readText('scripts/run-m0-regressions.mjs');

  assert.match(rootPackage.scripts.test, /@teacher-platform\/ops run test/);
  assert.match(gate, /run-m0-regressions\.mjs/);
  assert.match(regressions, /@teacher-platform\/ops/);
});
