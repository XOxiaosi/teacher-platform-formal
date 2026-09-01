import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = resolve(__dirname, '../..');
const safetyModuleUrl = pathToFileURL(
  resolve(backendRoot, 'scripts/test-database-safety.mjs'),
).href;

describe('测试数据库隔离边界', () => {
  it('隔离运行器保持 backend 为 Vitest 工作目录', () => {
    expect(process.cwd()).toBe(backendRoot);
  });

  it('backend 标准 test script 只能经过隔离运行器', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(backendRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.test).toBe('node scripts/run-tests-isolated.mjs');
    expect(packageJson.scripts?.test).not.toContain('vitest run');
  });

  it('拒绝非本地 PostgreSQL 作为测试建库来源', async () => {
    const { assertLocalDatabaseUrl } = await import(safetyModuleUrl);

    expect(() => assertLocalDatabaseUrl(new URL('postgresql://user@example.com:5432/app')))
      .toThrow(/SAFETY_BLOCK/);
    expect(() => assertLocalDatabaseUrl(new URL('postgresql://user@127.0.0.1:5432/app')))
      .not.toThrow();
  });

  it('临时库名必须使用固定前缀且不能等于来源库', async () => {
    const {
      assertSafeTestDatabaseName,
      buildTestDatabaseName,
    } = await import(safetyModuleUrl);

    const generated = buildTestDatabaseName('abcdef123456');
    expect(generated).toBe('teacher_platform_test_abcdef123456');
    expect(() => assertSafeTestDatabaseName(generated, 'teacher_platform')).not.toThrow();
    expect(() => assertSafeTestDatabaseName('teacher_platform', 'teacher_platform'))
      .toThrow(/SAFETY_BLOCK/);
    expect(() => assertSafeTestDatabaseName('unscoped_test', 'teacher_platform'))
      .toThrow(/SAFETY_BLOCK/);
  });
});
