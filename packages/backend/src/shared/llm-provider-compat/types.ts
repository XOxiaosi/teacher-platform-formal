/**
 * LLM Provider 兼容层类型（P7 渠道线 · t60，t57 设计 §1）。
 *
 * 统一内部请求/响应模型：复用 ai-client 的 ChatMessage / ChatToolDefinition / ToolCall
 * （零新类型）；协议适配器（ProtocolAdapter）负责内部模型 ↔ 厂商 payload 转换与错误归一。
 */

import type {
  ChatMessage,
  ChatToolDefinition,
  ToolCall,
} from '../ai-client/types.js';

// 复用 ai-client 类型（零新类型）：re-export 供适配器模块从本层导入。
export type {
  ChatMessage,
  ChatToolDefinition,
  ToolCall,
} from '../ai-client/types.js';

/** 协议族（适配器分发键）。 */
export type ProviderKind = 'openai' | 'anthropic';

/** 教师配置（provider-configs 表投影；t60 只消费字段形状，不依赖表）。 */
export interface ProviderConfig {
  providerKind: ProviderKind;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 统一内部请求（与 ai-client ChatMessage 对齐）。 */
export interface NormalizedRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  temperature?: number;
  /** 扩展位：阶段二流式评估（SSE）。 */
  stream?: boolean;
}

/** 统一内部响应（含用量，供 provider-usage 采集）。 */
export interface NormalizedResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

/** 错误归一（t57 §1.4）——Error 子类：兼容现有 ai-client/重试的错误处理（error.message）。 */
export type ProviderErrorKind =
  | 'auth'               // 401/403：apiKey 无效/过期
  | 'rate_limited'       // 429
  | 'timeout'            // 请求超时（AbortSignal.timeout）
  | 'invalid_request'    // 400/422：payload 转换错误
  | 'provider_down'      // 5xx / 网络错误
  | 'model_not_found'    // 404 model
  | 'unknown';

export interface ProviderErrorFields {
  kind: ProviderErrorKind;
  status: number;
  retryable: boolean;
}

export class ProviderError extends Error implements ProviderErrorFields {
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly retryable: boolean;

  constructor(fields: ProviderErrorFields & { message: string }) {
    super(fields.message);
    this.name = 'ProviderError';
    this.kind = fields.kind;
    this.status = fields.status;
    this.retryable = fields.retryable;
  }
}

export function providerError(
  kind: ProviderErrorKind,
  status: number,
  message: string,
  retryable = false,
): ProviderError {
  return new ProviderError({ kind, status, message, retryable });
}

/** 协议适配器接口（dispatcher 分发目标）。 */
export interface ProtocolAdapter {
  kind: ProviderKind;
  matches(config: ProviderConfig): boolean;
  buildPayload(req: NormalizedRequest): unknown;
  parseResponse(data: unknown): NormalizedResponse;
  normalizeError(status: number, data: unknown): ProviderError;
}
