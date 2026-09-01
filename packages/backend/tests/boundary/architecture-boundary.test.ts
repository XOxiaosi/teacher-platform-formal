import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(TEST_DIR, '../..');
const SRC_ROOT = resolve(BACKEND_ROOT, 'src');

interface SourceFile {
  absolutePath: string;
  sourceRelativePath: string;
  content: string;
}

interface ImportRecord {
  importer: SourceFile;
  specifier: string;
  resolvedPath: string | null;
}

function walkTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolutePath = resolve(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) return walkTsFiles(absolutePath);
    if (entry.endsWith('.ts')) return [absolutePath];
    return [];
  });
}

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function readSourceFiles(): SourceFile[] {
  return walkTsFiles(SRC_ROOT).map((absolutePath) => ({
    absolutePath,
    sourceRelativePath: toPosixPath(relative(SRC_ROOT, absolutePath)),
    content: readFileSync(absolutePath, 'utf8'),
  }));
}

function extractImportSpecifiers(content: string): string[] {
  const regex = /(?:import(?:\s+type)?[\s\S]*?from\s*['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  return [...content.matchAll(regex)].map((match) => match[1] ?? match[2]).filter(Boolean);
}

function resolveImport(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutExtension = resolve(dirname(importerPath), specifier);
  if (withoutExtension.endsWith('.js')) return `${withoutExtension.slice(0, -3)}.ts`;
  if (withoutExtension.endsWith('.ts')) return withoutExtension;
  return `${withoutExtension}.ts`;
}

function collectImports(): ImportRecord[] {
  return readSourceFiles().flatMap((sourceFile) => extractImportSpecifiers(sourceFile.content).map((specifier) => ({
    importer: sourceFile,
    specifier,
    resolvedPath: resolveImport(sourceFile.absolutePath, specifier),
  })));
}

function featureName(sourceRelativePath: string): string | null {
  const parts = sourceRelativePath.split('/');
  if (parts[0] !== 'features') return null;
  return parts[1] ?? null;
}

describe('架构边界测试', () => {
  it('feature 模块之间保持零依赖，不跨 feature import', () => {
    const violations = collectImports().flatMap((record) => {
      if (!record.resolvedPath) return [];
      const importerFeature = featureName(record.importer.sourceRelativePath);
      const importedRelativePath = toPosixPath(relative(SRC_ROOT, record.resolvedPath));
      const importedFeature = featureName(importedRelativePath);
      if (!importerFeature || !importedFeature || importerFeature === importedFeature) return [];
      return [`${record.importer.sourceRelativePath} -> ${record.specifier}`];
    });

    expect(violations).toEqual([]);
  });

  it('features/shared/adapters 不反向 import app 层', () => {
    const lowerLayerPrefixes = ['features/', 'shared/', 'adapters/'];
    const violations = collectImports().flatMap((record) => {
      if (!lowerLayerPrefixes.some((prefix) => record.importer.sourceRelativePath.startsWith(prefix))) return [];
      if (record.specifier.includes('/app/')) return [`${record.importer.sourceRelativePath} -> ${record.specifier}`];
      if (!record.resolvedPath) return [];
      const importedRelativePath = toPosixPath(relative(SRC_ROOT, record.resolvedPath));
      if (!importedRelativePath.startsWith('app/')) return [];
      return [`${record.importer.sourceRelativePath} -> ${record.specifier}`];
    });

    expect(violations).toEqual([]);
  });

  it('shared 基础设施层不 import feature 业务层', () => {
    const violations = collectImports().flatMap((record) => {
      if (!record.importer.sourceRelativePath.startsWith('shared/')) return [];
      if (record.specifier.includes('/features/')) return [`${record.importer.sourceRelativePath} -> ${record.specifier}`];
      if (!record.resolvedPath) return [];
      const importedRelativePath = toPosixPath(relative(SRC_ROOT, record.resolvedPath));
      if (!importedRelativePath.startsWith('features/')) return [];
      return [`${record.importer.sourceRelativePath} -> ${record.specifier}`];
    });

    expect(violations).toEqual([]);
  });
});
