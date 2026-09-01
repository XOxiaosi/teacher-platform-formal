/**
 * ProviderRouter 实现：按 teacherId 从 ProviderConfig 存储解析主 LLM provider（t66，t57 设计 §3）。
 *
 * - 读共享库 ProviderConfig（primary 优先；status=active）→ createLlmProvider 构建 AiProvider；
 * - 两层缓存：
 *   1. configCache：providerName→config 映射，TTL registryCacheTtlMs（默认 60s，与 database-pool 同风格）；
 *   2. providerCache：Map<configId, AiProvider>——同 provider+model+apiKey 复用已建实例（连接复用）；
 * - 无配置 / status=disabled / 读取失败 → isDefault=true（调用方回退 defaultProvider，零破坏）。
 *
 * 注意：apiKeyEnc 解密需要 PROVIDER_KEY_ENCRYPTION_KEY env（api-key-crypto 内部校验）。
 */

import type { AiProvider } from './types.js';
import type { ProviderConfig } from '../llm-provider-compat/types.js';
import { createLlmProvider } from '../llm-provider-compat/index.js';
import { decryptApiKey } from '../llm-provider-compat/api-key-crypto.js';
import type { ResolvedProvider } from './routing-ai-client.js';

export interface ProviderConfigRow {
  id: string;
  providerKind: string;
  providerName: string;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
  isPrimary: boolean;
  status: string;
}

export interface CreateProviderRouterOptions {
  /** 共享库查询：按 teacherId 取 active 配置（primary 优先）。实现方注入（L4 装配共享库 client）。 */
  loadConfigs: (teacherId: string) => Promise<ProviderConfigRow[]>;
  /** 配置缓存 TTL（ms）；默认 60_000。 */
  registryCacheTtlMs?: number;
  /** 日志/错误回调（缺省静默）。 */
  onError?: (teacherId: string, error: unknown) => void;
}

export interface ProviderRouterImpl {
  resolve(teacherId: string): Promise<ResolvedProvider>;
  /** 测试/运维：清空两级缓存。 */
  clearCache(): void;
}

export function createProviderConfigRouter(options: CreateProviderRouterOptions): ProviderRouterImpl {
  const ttlMs = options.registryCacheTtlMs ?? 60_000;
  // configCache: teacherId → { configs, fetchedAt }
  const configCache = new Map<string, { configs: ProviderConfigRow[]; fetchedAt: number }>();
  // providerCache: configId → AiProvider
  const providerCache = new Map<string, AiProvider>();

  function cachedConfigs(teacherId: string): ProviderConfigRow[] {
    const entry = configCache.get(teacherId);
    if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry.configs;
    return [];
  }

  function activeConfig(configs: ProviderConfigRow[]): ProviderConfigRow | undefined {
    // primary 优先；无 primary 取最新 active
    const active = configs.filter((config) => config.status === 'active');
    if (active.length === 0) return undefined;
    return active.find((config) => config.isPrimary) ?? active[active.length - 1];
  }

  function buildProvider(config: ProviderConfigRow): AiProvider {
    const cached = providerCache.get(config.id);
    if (cached) return cached;
    const plainKey = decryptApiKey(config.apiKeyEnc);
    const provider = createLlmProvider({
      providerKind: config.providerKind === 'anthropic' ? 'anthropic' : 'openai',
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      apiKey: plainKey,
      model: config.model,
    });
    providerCache.set(config.id, provider);
    return provider;
  }

  return {
    async resolve(teacherId: string): Promise<ResolvedProvider> {
      if (!teacherId) {
        return { provider: undefined as unknown as AiProvider, isDefault: true };
      }
      let configs = cachedConfigs(teacherId);
      if (configs.length === 0) {
        try {
          configs = await options.loadConfigs(teacherId);
          configCache.set(teacherId, { configs, fetchedAt: Date.now() });
        } catch (error) {
          options.onError?.(teacherId, error);
          return { provider: undefined as unknown as AiProvider, isDefault: true };
        }
      }
      const config = activeConfig(configs);
      if (!config) {
        // 有缓存但无 active 配置（可能刚被禁用）——回退默认
        return { provider: undefined as unknown as AiProvider, isDefault: true };
      }
      try {
        const provider = buildProvider(config);
        return { provider, configId: config.id, config: toProviderConfig(config), isDefault: false };
      } catch (error) {
        options.onError?.(teacherId, error);
        return { provider: undefined as unknown as AiProvider, isDefault: true };
      }
    },
    clearCache() {
      configCache.clear();
      providerCache.clear();
    },
  };
}

function toProviderConfig(row: ProviderConfigRow): ProviderConfig {
  return {
    providerKind: row.providerKind === 'anthropic' ? 'anthropic' : 'openai',
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    apiKey: '***', // 不出内存对象明文（实际 provider 已用明文构建，这里仅元数据）
    model: row.model,
  };
}
