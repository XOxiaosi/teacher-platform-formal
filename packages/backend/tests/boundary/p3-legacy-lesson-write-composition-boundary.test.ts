import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sourcesRecursively(path: string): string[] {
  const directory = resolve(ROOT, path);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourcesRecursively(resolve(path, entry.name));
    return entry.isFile() && entry.name.endsWith('.ts') ? [readFileSync(entryPath, 'utf8')] : [];
  });
}

describe('P3 课次状态写入生产装配边界', () => {
  it('全部生产 composition 与 routes 只装配正式出勤更正，不接入历史 Lesson 直改用例', () => {
    const composition = source('src/app/composition/core-route-dependencies.ts');
    const productionSources = [
      ...sourcesRecursively('src/app/composition'),
      ...sourcesRecursively('src/app/routes'),
    ].join('\n');

    expect(composition).toContain('createLessonStatusFixUseCase');
    expect(productionSources).not.toContain('lesson-reminder');
    expect(productionSources).not.toContain('daily-review-interact');
    expect(productionSources).not.toContain('createLessonReminderUseCase');
    expect(productionSources).not.toContain('createDailyReviewInteractUseCase');
  });
});
