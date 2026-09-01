import { describe, expect, it } from 'vitest';
import { createFeedbackService } from '../../../src/features/feedback/index.js';

const SERVICE_METHODS = [
  'createFeedback',
  'getFeedback',
  'listFeedbacks',
  'updateFeedbackContent',
  'updateFeedbackStatus',
] as const;

describe('feedback feature 服务导出契约', () => {
  it('导出服务工厂函数', () => {
    expect(createFeedbackService).toBeTypeOf('function');
  });

  it('工厂返回全部 5 个服务方法', () => {
    const service = createFeedbackService({} as never);

    for (const method of SERVICE_METHODS) {
      expect(service[method]).toBeTypeOf('function');
    }
  });
});
