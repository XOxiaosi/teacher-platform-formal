import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../../src');

function read(relativePath: string): string {
  try {
    return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

describe('Memo edit command static boundaries', () => {
  it('production factory使用raw transaction、数据库clock、显式ChangeLog和sentinel回滚', () => {
    const source = read('app/use-cases/update-memo/index.ts');

    expect(source).toContain('rawPrisma.$transaction');
    expect(source).toContain('createDatabaseTrustedClock');
    expect(source).toContain('createChangelogService');
    expect(source).toMatch(/if \(!result\.ok\) throw new \w+Rollback/);
    expect(source).toContain('createMemoEditor');
  });

  it('owner只使用teacher+id+updatedAt的updateMany CAS并禁止状态与来源进入data', () => {
    const source = read('features/memos/memo-editor.ts');
    const updateData = source.slice(
      source.indexOf('function buildUpdateData'),
      source.indexOf('function toMemoData'),
    );

    expect(source).toContain('prisma.memo.updateMany');
    expect(source).toMatch(/where:\s*\{[\s\S]*id: input\.memoId,[\s\S]*teacherId: input\.teacherId,[\s\S]*updatedAtTs: before\.updatedAtTs/);
    expect(source).not.toContain('prisma.memo.update({');
    expect(source).not.toMatch(/data:\s*input\.changes/);
    expect(source).not.toMatch(/data:\s*\{\s*\.\.\.input\.changes/);
    expect(updateData).not.toContain('status');
    expect(updateData).not.toContain('source');
    expect(updateData).toContain('Prisma.DbNull');
  });

  it('纯应用use-case不import Prisma、不直接写数据库、不接受通用patch或caller snapshot', () => {
    const source = read('app/use-cases/update-memo/update-memo-use-case.ts');

    expect(source).not.toContain('@prisma/client');
    expect(source).not.toMatch(/prisma\.[A-Za-z]/);
    expect(source).not.toMatch(/updateAnything|tableName|modelName|fieldPath|JSON Patch/i);
    expect(source).not.toMatch(/recordChange\([^)]*command\.before/);
    expect(source).not.toMatch(/recordChange\([^)]*command\.after/);
  });

  it('legacy updateMemo与状态方法保持独立，typed command位于新owner', () => {
    const legacy = read('features/memos/memo-service.ts');
    const index = read('features/memos/index.ts');

    expect(legacy).toContain('async updateMemo(input)');
    expect(legacy).toContain('where: { id: input.memoId }');
    expect(legacy).toContain('async updateMemoStatus(input)');
    expect(index).toContain("export { createMemoService } from './memo-service.js'");
    expect(index).toContain("export { createMemoEditor } from './memo-editor.js'");
  });
});
