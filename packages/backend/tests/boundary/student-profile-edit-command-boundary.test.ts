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

describe('Student profile edit command static boundaries', () => {
  it('production factory使用raw interactive transaction、数据库clock和显式ChangeLog，并以sentinel回滚Result Err', () => {
    const source = read('app/use-cases/update-student-profile/index.ts');

    expect(source).toContain('rawPrisma.$transaction');
    expect(source).toContain('createDatabaseTrustedClock');
    expect(source).toContain('createChangelogService');
    expect(source).toMatch(/if \(!result\.ok\) throw new \w+Rollback/);
    expect(source).toContain('createStudentProfileEditor');
  });

  it('owner只使用teacher+id+updatedAt的updateMany CAS，不退化为按ID update', () => {
    const source = read('features/students/student-profile-editor.ts');

    expect(source).toContain('prisma.student.updateMany');
    expect(source).toMatch(/where:\s*\{[\s\S]*id: input\.studentId,[\s\S]*teacherId: input\.teacherId,[\s\S]*updatedAtTs: before\.updatedAtTs/);
    expect(source).not.toContain('prisma.student.update({');
    expect(source).not.toMatch(/data:\s*input\.changes/);
    expect(source).not.toMatch(/data:\s*\{\s*\.\.\.input\.changes/);
  });

  it('纯应用use-case不import Prisma、不直接写数据库、不接受通用patch协议', () => {
    const source = read('app/use-cases/update-student-profile/update-student-profile-use-case.ts');

    expect(source).not.toContain('@prisma/client');
    expect(source).not.toMatch(/prisma\.[A-Za-z]/);
    expect(source).not.toMatch(/updateAnything|tableName|modelName|fieldPath|JSON Patch/i);
    expect(source).not.toMatch(/recordChange\([^)]*command\.before/);
    expect(source).not.toMatch(/recordChange\([^)]*command\.after/);
  });

  it('legacy updateStudent仍保留原按ID方法，typed command位于独立owner', () => {
    const legacy = read('features/students/student-service.ts');
    const index = read('features/students/index.ts');

    expect(legacy).toContain('async updateStudent(input: UpdateStudentInput)');
    expect(legacy).toContain('where: { id: input.studentId }');
    expect(index).toContain("export { createStudentService } from './student-service.js'");
    expect(index).toContain("export { createStudentProfileEditor } from './student-profile-editor.js'");
  });
});
