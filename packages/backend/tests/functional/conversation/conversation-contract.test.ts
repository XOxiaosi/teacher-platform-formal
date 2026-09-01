import { describe, expect, it } from 'vitest';
import { createConversationService } from '../../../src/features/conversation/index.js';

const SERVICE_METHODS = [
  'createConversation',
  'getConversation',
  'appendTurn',
  'listTurns',
  'buildContext',
  'archiveConversation',
  'updateSummary',
] as const;

describe('conversation feature 服务导出契约', () => {
  it('导出服务工厂函数', () => {
    expect(createConversationService).toBeTypeOf('function');
  });

  it('工厂返回全部 7 个服务方法', () => {
    const service = createConversationService({} as never);

    for (const method of SERVICE_METHODS) {
      expect(service[method]).toBeTypeOf('function');
    }
  });
});
