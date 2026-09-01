import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Manifest = {
  packageManager?: string;
  main?: string;
  types?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type LockPackage = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const projectRoot = resolve(__dirname, '../../../..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf8')) as T;
}

describe('可复现安装、构建与运行时边界', () => {
  it('contracts 提供 dist 运行时入口及自有构建', () => {
    const root = readJson<Manifest>('package.json');
    const contracts = readJson<Manifest>('packages/contracts/package.json');

    expect(root.packageManager).toBe('npm@10.9.2');
    const build = root.scripts?.build ?? '';
    expect(build).toContain('npm -w @teacher-platform/api-contracts run build');
    expect(build).toContain('npm -w @teacher-platform/domain run build');
    expect(build).toContain('npm -w @teacher-platform/contracts run build');
    expect(build).toContain('npm -w @teacher-platform/backend run build');
    expect(build.indexOf('@teacher-platform/api-contracts')).toBeLessThan(build.indexOf('@teacher-platform/contracts'));
    expect(build.indexOf('@teacher-platform/domain')).toBeLessThan(build.indexOf('@teacher-platform/contracts'));
    expect(contracts.main).toBe('./dist/index.js');
    expect(contracts.types).toBe('./dist/index.d.ts');
    expect(contracts.scripts?.build).toBe('npm run db:generate && tsc -p tsconfig.json');
    expect(existsSync(resolve(projectRoot, 'packages/contracts/tsconfig.json'))).toBe(true);
  });

  it('运行时依赖由实际使用它的 workspace 声明', () => {
    const backend = readJson<Manifest>('packages/backend/package.json');
    const contracts = readJson<Manifest>('packages/contracts/package.json');

    expect(backend.dependencies?.['@prisma/client']).toBe('^6.19.3');
    expect(contracts.dependencies?.['@prisma/client']).toBe('^6.19.3');
    expect(contracts.devDependencies?.typescript).toBe('^6.0.3');
  });

  it('package-lock 的 workspace 依赖规格与 manifests 完全一致', () => {
    const lock = readJson<{ packages: Record<string, LockPackage> }>('package-lock.json');
    const workspaces = [
      ['', 'package.json'],
      ['packages/api-contracts', 'packages/api-contracts/package.json'],
      ['packages/domain', 'packages/domain/package.json'],
      ['packages/backend', 'packages/backend/package.json'],
      ['packages/contracts', 'packages/contracts/package.json'],
      ['packages/frontend', 'packages/frontend/package.json'],
    ] as const;

    for (const [lockKey, manifestPath] of workspaces) {
      const manifest = readJson<Manifest>(manifestPath);
      const locked = lock.packages[lockKey];
      expect(locked, `${lockKey || 'root'} 缺少 lock entry`).toBeDefined();
      expect(locked.dependencies ?? {}).toEqual(manifest.dependencies ?? {});
      expect(locked.devDependencies ?? {}).toEqual(manifest.devDependencies ?? {});
    }
  });

  it('根包暴露编译产物 smoke 命令及实现', () => {
    const root = readJson<Manifest>('package.json');

    expect(root.scripts?.['smoke:backend']).toBe('node scripts/smoke-built-backend.mjs');
    expect(existsSync(resolve(projectRoot, 'scripts/smoke-built-backend.mjs'))).toBe(true);
  });
});
