/**
 * 按教师路由的 AiClient（P7 渠道线 · t66，t57 设计 §3）。
 *
 * createRoutingAiClient：AiClient 接口不变（run/chat 同签名，8+ 消费点零改动），
 * 请求期按 teacherId 经 ProviderRouter 解析 provider：
 * - 有配置（status=active）→ 路由到该教师配置的 provider（按 configId 缓存实例，复用）；
 * - 无配置 / status=disabled / resolve 失败 → 回退 defaultProvider（现有 ark env 行为，零破坏）；
 * - 配置 provider 调用失败 → 记录 ProviderError 不静默换 provider，返回错误信封（阶段二再做降级）。
 *
 * teacherId 来源：AsyncLocalStorage（runAsTeacher 包裹请求，L4 装配在路由中间件调用）；
 * 无请求上下文（后台任务/单测直调）→ teacherId 为空 → 走默认 provider。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { err, internalError, validationError, type Result, type CommonError } from '@teacher-platform/contracts';
import type { AiClient, AiProvider, AiTask, ChatMessage, ChatToolDefinition, ChatResponse, AiOutput } from './types.js';
import type { ProviderConfig, ProviderError } from '../llm-provider-compat/types.js';

/** 按 teacherId 解析 provider 的路由器契约（装配线实现，L4 backend3）。 */
export interface ProviderRouter {
  /** 返回该教师的 provider；无配置/disabled 由实现方返回 isDefault=true。 */
  resolve(teacherId: string): Promise<ResolvedProvider>;
}

export interface ResolvedProvider {
  provider: AiProvider;
  /** ProviderConfig 表主键；仅作 ProviderUsage 追溯元数据，不包含密钥。 */
  configId?: string;
  config?: ProviderConfig;
  isDefault: boolean;
}

export interface CreateRoutingAiClientOptions {
  /** 平台默认 provider（现有 ark env 实现）——无配置/disabled 回退目标。 */
  defaultProvider: AiProvider;
  resolver: ProviderRouter;
  /** 路由解析失败时的错误回调（日志/指标；缺省静默）。 */
  onResolveError?: (teacherId: string, error: unknown) => void;
  /** 配置 provider 调用失败时的错误回调（记录 ProviderError，不降级）。 */
  onProviderError?: (teacherId: string, error: ProviderError) => void;
  /** 用量采集回调（t69：chat/run 成功后记录实耗；缺省不记录）。 */
  onUsage?: (input: UsageRecordInput) => void;
}

/** 用量采集入参（t69：provider-usage-service.record 的输入形状，避免循环依赖）。 */
export interface UsageRecordInput {
  teacherId: string;
  providerConfigId?: string | null;
  providerName: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  requestMessages?: ChatMessage[];
  responseContent?: string;
  conversationId?: string | null;
  requestAt?: Date;
}

const teacherStorage = new AsyncLocalStorage<string>();

/** 在指定教师身份上下文中执行（L4 路由中间件调用；无上下文时走默认 provider）。 */
export function runAsTeacher<T>(teacherId: string, fn: () => T): T {
  return teacherStorage.run(teacherId, fn);
}

/** 读取当前请求教师 id（无请求上下文返回空串）。 */
export function currentTeacherId(): string {
  return teacherStorage.getStore() ?? '';
}

function isProviderError(error: unknown): error is ProviderError {
  return !!error && typeof error === 'object' && 'kind' in error && 'retryable' in error;
}

export function createRoutingAiClient(options: CreateRoutingAiClientOptions): AiClient {
  const { defaultProvider, resolver } = options;

  async function resolveProvider(teacherId: string): Promise<ResolvedProvider> {
    if (!teacherId) return { provider: defaultProvider, isDefault: true };
    try {
      const resolved = await resolver.resolve(teacherId);
      return resolved.isDefault || !resolved.provider
        ? { provider: defaultProvider, isDefault: true }
        : resolved;
    } catch (error) {
      options.onResolveError?.(teacherId, error);
      return { provider: defaultProvider, isDefault: true };
    }
  }

  async function withProvider<T>(
    teacherId: string,
    run: (resolved: ResolvedProvider) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>> {
    const resolved = await resolveProvider(teacherId);
    return run(resolved);
  }

  /** ProviderError → CommonError 信封；触发 onProviderError 回调（kind 细节透出）。 */
  function toCommonError(teacherId: string, error: unknown): CommonError {
    if (isProviderError(error)) {
      if (teacherId) options.onProviderError?.(teacherId, error);
      return internalError(`AI provider 错误（${error.kind}）：${error.message}`);
    }
    return internalError(`AI 调用失败：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 成功后记录用量（t69：厂商 usage 优先，无则留空由 usage 服务 estimateTokens 兜底）。 */
  function recordUsage(
    teacherId: string,
    resolved: ResolvedProvider,
    requestMessages: ChatMessage[],
    responseContent: string,
    promptTokens?: number,
    completionTokens?: number,
  ): void {
    if (!teacherId || !options.onUsage) return;
    // createLlmProvider 暴露 lastUsage（非枚举可选字段）
    const providerWithUsage = resolved.provider as AiProvider & { lastUsage?: { promptTokens?: number; completionTokens?: number } };
    options.onUsage({
      teacherId,
      providerConfigId: resolved.configId ?? null,
      providerName: resolved.config?.providerName ?? 'default',
      model: resolved.config?.model ?? 'default',
      promptTokens: providerWithUsage.lastUsage?.promptTokens ?? promptTokens,
      completionTokens: providerWithUsage.lastUsage?.completionTokens ?? completionTokens,
      requestMessages: promptTokens === undefined && !providerWithUsage.lastUsage ? requestMessages : undefined,
      responseContent: completionTokens === undefined && !providerWithUsage.lastUsage ? responseContent : undefined,
    });
  }

  return {
    async run(task: AiTask) {
      if (!task.input) {
        return err(validationError('AI 输入不能为空', 'input'));
      }
      const teacherId = currentTeacherId();
      return withProvider(teacherId, async (resolved) => {
        const { provider } = resolved;
        const requestMessages: ChatMessage[] = [
          { role: 'system', content: '结构化解析' },
          { role: 'user', content: JSON.stringify(task.input) },
        ];
        try {
          const output = await provider.run(task);
          const content = typeof output === 'string' ? output : JSON.stringify(output);
          recordUsage(teacherId, resolved, requestMessages, content);
          return { ok: true, value: output as AiOutput };
        } catch (error) {
          return err(toCommonError(teacherId, error));
        }
      });
    },

    async chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<Result<ChatResponse, CommonError>> {
      if (!Array.isArray(messages) || messages.length === 0) {
        return err(validationError('messages 不能为空数组', 'messages'));
      }
      if (!Array.isArray(tools)) {
        return err(validationError('tools 必须是数组', 'tools'));
      }
      const teacherId = currentTeacherId();
      return withProvider(teacherId, async (resolved) => {
        const { provider } = resolved;
        if (!provider.chat) {
          return err(internalError('当前 AI provider 不支持 chat'));
        }
        try {
          const response = await provider.chat(messages, tools);
          recordUsage(teacherId, resolved, messages, response.content);
          return { ok: true, value: response as ChatResponse };
        } catch (error) {
          return err(toCommonError(teacherId, error));
        }
      });
    },
  };
}
