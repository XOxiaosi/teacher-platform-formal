import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../../src');
function read(relativePath: string): string {
  try { return readFileSync(resolve(sourceRoot, relativePath), 'utf8'); } catch { return ''; }
}

describe('ParentFeedback content edit command static boundaries', () => {
  it('production factory使用raw transaction、数据库clock、显式ChangeLog和sentinel', () => {
    const source = read('app/use-cases/update-parent-feedback-content/index.ts');
    expect(source).toContain('rawPrisma.$transaction');
    expect(source).toContain('createDatabaseTrustedClock');
    expect(source).toContain('createChangelogService');
    expect(source).toMatch(/if \(!result\.ok\) throw new \w+Rollback/);
    expect(source).toContain('createParentFeedbackContentEditor');
  });

  it('owner仅以teacher+id+updatedAt执行updateMany CAS且data只含内容字段', () => {
    const source = read('features/feedback/parent-feedback-content-editor.ts');
    const updateData = source.slice(
      source.indexOf('function buildUpdateData'),
      source.indexOf('export function createParentFeedbackContentEditor'),
    );
    expect(source).toContain('prisma.parentFeedback.updateMany');
    expect(source).toMatch(/where:\s*\{[\s\S]*id: input\.feedbackId,[\s\S]*teacherId: input\.teacherId,[\s\S]*updatedAtTs: before\.updatedAtTs/);
    expect(source).not.toContain('prisma.parentFeedback.update({');
    expect(source).not.toMatch(/data:\s*input\.changes|data:\s*\{\s*\.\.\.input\.changes/);
    expect(updateData).not.toMatch(/status|sentAt|studentId|lessonId|channel|parentName/);
  });

  it('纯应用use-case不import Prisma、不直接写数据库、不接受通用patch或caller快照', () => {
    const source = read('app/use-cases/update-parent-feedback-content/update-parent-feedback-content-use-case.ts');
    expect(source).not.toContain('@prisma/client');
    expect(source).not.toMatch(/prisma\.[A-Za-z]/);
    expect(source).not.toMatch(/updateAnything|tableName|modelName|fieldPath|JSON Patch/i);
    expect(source).not.toMatch(/recordChange\([^)]*command\.(before|after)/);
  });

  it('旧feedback内容与状态方法保持独立，typed command位于新owner', () => {
    const legacy = read('features/feedback/feedback-service.ts');
    const index = read('features/feedback/index.ts');
    expect(legacy).toContain('async updateFeedbackContent(input)');
    expect(legacy).toContain('async updateFeedbackStatus(input)');
    expect(index).toContain("export { createFeedbackService } from './feedback-service.js'");
    expect(index).toContain("export { createParentFeedbackContentEditor } from './parent-feedback-content-editor.js'");
  });
});
