import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wechatSource = readFileSync(
  new URL('../../src/app/composition/wechat-assembly.ts', import.meta.url),
  'utf8',
);
const coreDependenciesSource = readFileSync(
  new URL('../../src/app/composition/core-route-dependencies.ts', import.meta.url),
  'utf8',
);
const coreRoutesSource = readFileSync(
  new URL('../../src/app/routes/core.routes.ts', import.meta.url),
  'utf8',
);
const frontendConversationSource = readFileSync(
  new URL('../../../frontend/src/api/conversations.ts', import.meta.url),
  'utf8',
);

describe('微信生产装配的 DSH 单一路径', () => {
  it('使用 teaching-task 会话和执行适配器，不再接入旧 agentConverse', () => {
    expect(wechatSource).toContain('conversationService: teachingTasks');
    expect(wechatSource).toContain('createWechatTeachingTaskAgent');
    expect(wechatSource).toContain('agentConverse: teachingTaskAgent');
    expect(wechatSource).not.toContain('coreDeps.agent.agentConverse');
  });

  it('正式组合不构造或挂载旧 Agent，前端也不保留旧请求封装', () => {
    expect(coreDependenciesSource).not.toContain('createAgentConverseUseCase');
    expect(coreDependenciesSource).not.toContain('createMinimalToolRegistry');
    expect(coreDependenciesSource).toContain('const legacyAgent = options?.agentConverse');
    expect(coreRoutesSource).toContain('if (dependencies.agent)');
    expect(frontendConversationSource).not.toContain('/agent/converse');
    expect(frontendConversationSource).not.toContain('getAgentExecution');
    expect(frontendConversationSource).not.toContain('replayAgentExecution');
  });
});
