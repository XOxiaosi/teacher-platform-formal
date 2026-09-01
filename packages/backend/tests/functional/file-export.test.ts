import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileExportService } from '../../src/shared/file-export/index.js';
import { createStorage } from '../../src/shared/storage/index.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'teacher-platform-file-export-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('fileExport.exportMarkdown', () => {
  it('导出 Markdown 文本', async () => {
    const service = createFileExportService({ storage: createStorage({ rootDir }) });
    const result = await service.exportMarkdown({
      title: '学生档案',
      sections: [
        { heading: '基本信息', content: '姓名：张三' },
        { heading: '课时余额', content: '剩余 19 课时' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('# 学生档案');
    expect(result.value.content).toContain('## 基本信息');
    expect(result.value.content).toContain('姓名：张三');
  });
});

describe('fileExport.exportCsv', () => {
  it('导出 CSV 文本并处理逗号和引号', async () => {
    const service = createFileExportService({ storage: createStorage({ rootDir }) });
    const result = await service.exportCsv({
      columns: ['name', 'note'],
      rows: [
        { name: '张三', note: '状态好' },
        { name: '李四', note: '需要关注, 作业"未完成"' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('name,note');
    expect(result.value.content).toContain('"需要关注, 作业""未完成"""');
  });

  it('中和六种危险字符串首字符且不改变非字符串数据语义', async () => {
    const service = createFileExportService({ storage: createStorage({ rootDir }) });
    const result = await service.exportCsv({
      columns: ['equals', 'plus', 'minus', 'at', 'tab', 'carriage', 'number', 'boolean', 'plain'],
      rows: [{
        equals: '=1+1',
        plus: '+cmd',
        minus: '-10',
        at: '@SUM(A1:A2)',
        tab: '\tformula',
        carriage: '\r=1',
        number: -10,
        boolean: true,
        plain: "'already-safe",
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe([
      'equals,plus,minus,at,tab,carriage,number,boolean,plain',
      "'=1+1,'+cmd,'-10,'@SUM(A1:A2),'\tformula,\"'\r=1\",-10,true,'already-safe",
    ].join('\n'));
  });

  it('先中和危险表头和公式，再执行既有 CSV 引号转义', async () => {
    const service = createFileExportService({ storage: createStorage({ rootDir }) });
    const result = await service.exportCsv({
      columns: ['=dangerous-header', 'ordinary'],
      rows: [{
        '=dangerous-header': '=SUM(1,2)',
        ordinary: '需要关注, 作业"未完成"',
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe([
      "'=dangerous-header,ordinary",
      '"\'=SUM(1,2)","需要关注, 作业""未完成"""',
    ].join('\n'));
  });
});

describe('fileExport.exportPdf', () => {
  it('PDF 接口返回暂未实现', async () => {
    const service = createFileExportService({ storage: createStorage({ rootDir }) });
    const result = await service.exportPdf({ html: '<h1>测试</h1>' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('暂未实现');
  });
});

describe('fileExport.archive', () => {
  it('自动归档导出内容并返回 fileRef', async () => {
    const storage = createStorage({ rootDir });
    const service = createFileExportService({ storage });
    const exported = await service.exportMarkdown({
      title: '归档测试',
      sections: [{ heading: '内容', content: 'hello' }],
    });
    if (!exported.ok) return;

    const archived = await service.archive({
      filename: 'profile.md',
      content: exported.value.content,
      directory: 'exports',
    });

    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.fileRef).toContain('exports/');

    const read = await storage.read({ fileRef: archived.value.fileRef });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.toString()).toContain('# 归档测试');
  });
});
