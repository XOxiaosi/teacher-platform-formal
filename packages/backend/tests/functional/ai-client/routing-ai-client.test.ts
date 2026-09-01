import { describe, it, expect, vi } from 'vitest';
import {
  createRoutingAiClient,
  createProviderConfigRouter,
  runAsTeacher,
  currentTeacherId,
} from '../../../src/shared/ai-client/index.js';
import type { AiProvider, ChatMessage, ChatToolDefinition } from '../../../src/shared/ai-client/types.js';
import { encryptApiKey } from '../../../src/shared/llm-provider-compat/api-key-crypto.js';
import type { ProviderConfigRow } from '../../../src/shared/ai-client/provider-router.js';

process.env.PROVIDER_KEY_ENCRYPTION_KEY = 'c'.repeat(64);

/** 记录调用 provider 的假 provider。 */
function spyProvider(name: string, behavior?: { failOnce?: boolean }): AiProvider & { calls: number } {
  const provider = {
    calls: 0,
    async run() {
      provider.calls += 1;
      return { ok: true, value: { text: `${name}-run` } } as never;
    },
    async chat(messages: ChatMessage[], _tools: ChatToolDefinition[]) {
      provider.calls += 1;
      if (behavior?.failOnce && provider.calls === 1) {
        throw Object.assign(new Error('provider down'), { kind: 'provider_down', status: 503, retryable: true });
      }
      return { content: `${name}-reply:${messages[0]?.content ?? ''}` };
    },
  };
  return provider as AiProvider & { calls: number };
}

function configRow(overrides: Partial<ProviderConfigRow> = {}): ProviderConfigRow {
  return {
    id: 'cfg-1',
    providerKind: 'openai',
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: encryptApiKey('sk-test-1234'),
    model: 'deepseek-chat',
    isPrimary: true,
    status: 'active',
    ...overrides,
  };
}

describe('createRoutingAiClient：路由与回退', () => {
  it('无配置（isDefault）→ 回退 defaultProvider', async () => {
    const fallback = spyProvider('fallback');
    const client = createRoutingAiClient({
      defaultProvider: fallback,
      resolver: { async resolve() { return { provider: undefined as never, isDefault: true }; } },
    });
    const reply = await client.chat([{ role: 'user', content: 'hi' }], []);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.content).toBe('fallback-reply:hi');
    expect(fallback.calls).toBe(1);
  });

  it('有配置 → 路由到配置 provider（config 返回）', async () => {
    const fallback = spyProvider('fallback');
    const configured = spyProvider('configured');
    const onUsage = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: fallback,
      resolver: {
        async resolve(teacherId) {
          expect(teacherId).toBe('t1');
          return { provider: configured, configId: 'cfg-1', config: { providerKind: 'openai', providerName: 'deepseek', baseUrl: 'x', apiKey: 'sk', model: 'm' }, isDefault: false };
        },
      },
      onUsage,
    });
    const reply = await runAsTeacher('t1', () => client.chat([{ role: 'user', content: 'hi' }], []));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.content).toBe('configured-reply:hi');
    expect(configured.calls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 't1',
      providerConfigId: 'cfg-1',
      providerName: 'deepseek',
      model: 'm',
    }));
  });

  it('无请求上下文（teacherId 空）→ 回退默认（后台任务零破坏）', async () => {
    const fallback = spyProvider('fallback');
    const resolver = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: fallback,
      resolver: { async resolve() { resolver(); return { provider: undefined as never, isDefault: true }; } },
    });
    const reply = await client.chat([{ role: 'user', content: 'background' }], []);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.content).toBe('fallback-reply:background');
    expect(resolver).not.toHaveBeenCalled(); // 无 teacherId 不查路由
  });

  it('resolve 抛错 → 回退默认 + onResolveError 回调', async () => {
    const fallback = spyProvider('fallback');
    const onResolveError = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: fallback,
      resolver: { async resolve() { throw new Error('db down'); } },
      onResolveError,
    });
    const reply = await runAsTeacher('t1', () => client.chat([{ role: 'user', content: 'hi' }], []));
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.content).toBe('fallback-reply:hi');
    expect(onResolveError).toHaveBeenCalledWith('t1', expect.any(Error));
  });

  it('配置 provider 调用失败（ProviderError）→ 错误信封透传 + onProviderError 回调，不静默换 provider', async () => {
    const fallback = spyProvider('fallback');
    const configured = spyProvider('configured', { failOnce: true });
    const onProviderError = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: fallback,
      resolver: { async resolve() { return { provider: configured, isDefault: false }; } },
      onProviderError,
    });
    const reply = await runAsTeacher('t1', () => client.chat([{ role: 'user', content: 'hi' }], []));
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.code).toBe('INTERNAL_ERROR');
    expect(reply.error.message).toContain('provider_down'); // kind 透出在消息
    expect(onProviderError).toHaveBeenCalledWith('t1', expect.objectContaining({ kind: 'provider_down' }));
    expect(fallback.calls).toBe(0); // 不静默降级
  });

  it('非 ProviderError 异常 → internalError 信封', async () => {
    const client = createRoutingAiClient({
      defaultProvider: { async run() { throw new Error('boom'); } } as AiProvider,
      resolver: { async resolve() { return { provider: undefined as never, isDefault: true }; } },
    });
    const result = await client.run({ taskType: 'intent_recognition', input: { text: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('runAsTeacher / currentTeacherId：上下文作用域正确', async () => {
    expect(currentTeacherId()).toBe('');
    const inside = runAsTeacher('t9', () => currentTeacherId());
    expect(inside).toBe('t9');
    expect(currentTeacherId()).toBe('');
  });
});

describe('createProviderConfigRouter：配置解析 + 缓存', () => {
  it('active primary 配置 → isDefault=false + provider 可用', async () => {
    const row = configRow();
    const router = createProviderConfigRouter({
      loadConfigs: async () => [row],
    });
    const resolved = await router.resolve('t1');
    expect(resolved.isDefault).toBe(false);
    expect(resolved.configId).toBe(row.id);
    expect(resolved.config?.providerName).toBe('deepseek');
    expect(resolved.config?.apiKey).toBe('***'); // 元数据不暴露明文
    // createLlmProvider 构建成功（不实际发网络请求——apiKey 为测试假 key）
    expect(typeof resolved.provider.chat).toBe('function');
    expect(typeof resolved.provider.run).toBe('function');
  });

  it('无配置 → isDefault=true（调用方回退）', async () => {
    const router = createProviderConfigRouter({ loadConfigs: async () => [] });
    const resolved = await router.resolve('t1');
    expect(resolved.isDefault).toBe(true);
  });

  it('status=disabled → isDefault=true（回退默认）', async () => {
    const router = createProviderConfigRouter({
      loadConfigs: async () => [configRow({ status: 'disabled' })],
    });
    const resolved = await router.resolve('t1');
    expect(resolved.isDefault).toBe(true);
  });

  it('loadConfigs 抛错 → isDefault=true + onError', async () => {
    const onError = vi.fn();
    const router = createProviderConfigRouter({
      loadConfigs: async () => { throw new Error('db down'); },
      onError,
    });
    const resolved = await router.resolve('t1');
    expect(resolved.isDefault).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('configCache：TTL 内复用，不重复 loadConfigs', async () => {
    const loadConfigs = vi.fn(async () => [configRow({ id: 'cfg-cached' })]);
    const router = createProviderConfigRouter({ loadConfigs, registryCacheTtlMs: 60_000 });
    await router.resolve('t1');
    await router.resolve('t1');
    expect(loadConfigs).toHaveBeenCalledTimes(1); // 60s 内只查一次
  });

  it('providerCache：同 configId 复用已建 provider（不重建）', async () => {
    const row = configRow({ id: 'cfg-reuse' });
    let buildCount = 0;
    const router = createProviderConfigRouter({
      loadConfigs: async () => {
        buildCount += 1;
        return [row];
      },
    });
    const first = await router.resolve('t1');
    const second = await router.resolve('t1');
    expect(second.provider).toBe(first.provider); // 同一实例
    expect(buildCount).toBe(1); // config 只查一次（缓存生效）
    expect(router.resolve('t1')).toBeInstanceOf(Promise);
  });

  it('clearCache：清空两级缓存后重新查询', async () => {
    const loadConfigs = vi.fn(async () => [configRow({ id: 'cfg-clear' })]);
    const router = createProviderConfigRouter({ loadConfigs, registryCacheTtlMs: 60_000 });
    await router.resolve('t1');
    router.clearCache();
    await router.resolve('t1');
    expect(loadConfigs).toHaveBeenCalledTimes(2);
  });
});

describe('createRoutingAiClient：用量采集（t69）', () => {
  it('chat 成功后触发 onUsage（provider 有 lastUsage 优先）', async () => {
    const provider = {
      async chat() {
        return { content: 'reply' };
      },
      lastUsage: { promptTokens: 30, completionTokens: 7 },
    } as AiProvider & { lastUsage?: { promptTokens: number; completionTokens: number } };
    const onUsage = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: provider,
      resolver: { async resolve() { return { provider, isDefault: false }; } },
      onUsage,
    });
    await runAsTeacher('t1', () => client.chat([{ role: 'user', content: 'hi' }], []));
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 't1',
      promptTokens: 30,
      completionTokens: 7,
      requestMessages: undefined, // 厂商 usage 存在 → 不传兜底输入
    }));
  });

  it('无 teacherId（无请求上下文）→ 不触发 onUsage（后台任务不记账）', async () => {
    const provider = { async chat() { return { content: 'reply' }; } } as AiProvider;
    const onUsage = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: provider,
      resolver: { async resolve() { return { provider, isDefault: false }; } },
      onUsage,
    });
    await client.chat([{ role: 'user', content: 'hi' }], []);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('调用失败 → 不触发 onUsage（只记成功实耗）', async () => {
    const provider = {
      async chat() { throw new Error('boom'); },
    } as AiProvider;
    const onUsage = vi.fn();
    const client = createRoutingAiClient({
      defaultProvider: provider,
      resolver: { async resolve() { return { provider, isDefault: false }; } },
      onUsage,
    });
    await runAsTeacher('t1', () => client.chat([{ role: 'user', content: 'hi' }], []));
    expect(onUsage).not.toHaveBeenCalled();
  });
});
