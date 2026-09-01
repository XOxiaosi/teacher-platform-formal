import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutoArchiveUseCase } from '../../../src/app/use-cases/auto-archive/index.js';
import { createStorage } from '../../../src/shared/storage/index.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'teacher-platform-auto-archive-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('autoArchiveUseCase.autoArchive', () => {
  it('按日期、学生姓名、归档类型生成 Markdown 归档文件', async () => {
    const storage = createStorage({ rootDir });
    const useCase = createAutoArchiveUseCase({ storage });

    const result = await useCase.autoArchive({
      archiveType: 'lesson',
      recordId: 'lesson-001',
      studentName: '周九',
      date: new Date('2025-04-10T20:30:00+08:00'),
      title: '周九课次归档',
      sections: [
        { heading: '课次状态', content: '已上课' },
        { heading: '课堂记录', content: '电磁感应专题完成' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recordId).toBe('lesson-001');
    expect(result.value.archiveType).toBe('lesson');
    expect(result.value.filename).toBe('2025-04-10_周九_课次.md');
    expect(result.value.fileRef).toContain('archives/lesson/');
    expect(result.value.fileRef).toContain('2025-04-10_周九_课次.md');

    const saved = await storage.read({ fileRef: result.value.fileRef });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const content = saved.value.toString('utf8');
    expect(content).toContain('# 周九课次归档');
    expect(content).toContain('## 课次状态');
    expect(content).toContain('已上课');
    expect(content).toContain('电磁感应专题完成');
  });

  it('数据不完整时返回 VALIDATION_ERROR 且不生成归档', async () => {
    const storage = createStorage({ rootDir });
    const useCase = createAutoArchiveUseCase({ storage });

    const result = await useCase.autoArchive({
      archiveType: 'daily-review',
      recordId: 'review-001',
      studentName: '   ',
      date: new Date('2025-04-10T00:00:00+08:00'),
      title: '每日回顾归档',
      sections: [{ heading: '回顾', content: '完成' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('studentName');
  });
});
