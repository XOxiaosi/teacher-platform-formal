import { describe, expect, it } from 'vitest';
import { createMemoService } from '../../../src/features/memos/index.js';

const SERVICE_METHODS = [
  'createMemo',
  'getMemo',
  'listMemos',
  'updateMemo',
  'updateMemoStatus',
  'listDueMemos',
] as const;

describe('memos feature 服务导出契约', () => {
  it('导出服务工厂函数', () => {
    expect(createMemoService).toBeTypeOf('function');
  });

  it('工厂返回全部 6 个服务方法', () => {
    const service = createMemoService({} as never);

    for (const method of SERVICE_METHODS) {
      expect(service[method]).toBeTypeOf('function');
    }
  });
});
