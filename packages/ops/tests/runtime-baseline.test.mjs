import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const opsRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = resolve(opsRoot, '../..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf8'));
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

test('M0 runtime baseline：旧部署与 CI 材料不成为 Active workspace 契约', () => {
  // 本轮迁移明确排除旧 deploy/CI/gate 资产；Active Gate 由当前根脚本和项目文档维护。
  for (const relativePath of [
    'deploy/runtime-baseline.json',
    'deploy/DEPLOY.md',
    'deploy/CI.md',
    'deploy/windows/README.md',
    '.github/workflows/ci.yml',
    'scripts/gate.mjs',
    'scripts/run-m0-regressions.mjs',
  ]) {
    assert.equal(
      existsSync(resolve(projectRoot, relativePath)),
      false,
      `旧迁移资产不应成为 Active workspace 文件：${relativePath}`,
    );
  }
});

test('M0 ops baseline：根测试入口执行受控数据库套件与 ops runner', () => {
  const rootPackage = readJson('package.json');

  assert.match(rootPackage.scripts.test, /node scripts\/run-tests-with-postgres\.mjs/);
  assert.equal(rootPackage.scripts['test:infrastructure'], 'node --test scripts/run-tests-with-postgres.test.mjs');
  assert.equal(typeof rootPackage.scripts['test:with-database'], 'string');
  assert.match(rootPackage.scripts['test:with-database'], /npm run test:infrastructure/);
  assert.match(rootPackage.scripts['test:with-database'], /@teacher-platform\/ops run test/);
  assert.equal(rootPackage.scripts['test:local-safe'], 'node --test scripts/start-local-safe.test.mjs scripts/smoke-built-backend.test.mjs');
});
