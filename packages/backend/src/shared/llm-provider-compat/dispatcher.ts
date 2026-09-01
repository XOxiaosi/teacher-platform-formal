/**
 * Provider 兼容层 dispatcher（P7 渠道线 · t60，t57 设计 §1.2）。
 *
 * 按 (providerKind, model) first-match-wins 分发到协议适配器；通用补丁
 * （stripEmptyTools 等与 provider 无关的逻辑）放本层，禁止 provider 特判下沉
 * 到适配器（openhanako provider-compat 同款纪律）。
 *
 * 顺序：anthropic 在前（协议族明确匹配），openai 为默认兜底（覆盖绝大多数国内厂商）。
 */

import type { NormalizedRequest, ProtocolAdapter } from './types.js';
import { createOpenAiCompatAdapter } from './openai-compat.js';
import { createAnthropicAdapter } from './anthropic.js';

const ADAPTERS: ProtocolAdapter[] = [
  createAnthropicAdapter(),   // 明确协议族匹配优先
  createOpenAiCompatAdapter(), // 默认兜底
];

/** 按 providerKind 分发（first-match-wins；openai 兜底恒命中）。 */
export function resolveAdapter(providerKind: string): ProtocolAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.kind === providerKind) return adapter;
  }
  return ADAPTERS[ADAPTERS.length - 1]; // 未识别协议族 → 默认 OpenAI 兼容
}

/**
 * 通用补丁：无 tools 时不发送空 tools 数组（DeepSeek 等厂商在 tools:[] 时报错；
 * 智谱部分模型同理）。返回新请求对象（不 mutate 入参）。
 */
export function stripEmptyTools(req: NormalizedRequest): NormalizedRequest {
  if (req.tools && req.tools.length > 0) return req;
  return {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    stream: req.stream,
  };
}

/** 兼容层统一入口：内部请求 → 厂商 payload（含通用补丁）。 */
export function buildProviderPayload(providerKind: string, req: NormalizedRequest): unknown {
  const adapter = resolveAdapter(providerKind);
  return adapter.buildPayload(stripEmptyTools(req));
}
