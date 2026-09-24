import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../src/app/composition/wechat-assembly.ts', import.meta.url),
  'utf8',
);

describe('微信生产装配的 DSH 单一路径', () => {
  it('使用 teaching-task 会话和执行适配器，不再接入旧 agentConverse', () => {
    expect(source).toContain('conversationService: teachingTasks');
    expect(source).toContain('createWechatTeachingTaskAgent');
    expect(source).toContain('agentConverse: teachingTaskAgent');
    expect(source).not.toContain('coreDeps.agent.agentConverse');
  });
});
