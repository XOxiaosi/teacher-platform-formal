/**
 * LLM Provider 兼容层入口（P7 渠道线 · t60，t57 设计 §1）。
 *
 * createLlmProvider(config)：给定教师 ProviderConfig（providerKind/baseUrl/apiKey/model），
 * 返回一个 AiProvider（复用 ai-client 接口）——内部按协议族经 dispatcher 分发到
 * openai-compat / anthropic 适配器，统一错误归一（ProviderError）。
 *
 * 装配（L4，backend3）：AiClient 改造为按 teacherId 路由时，用本工厂按需创建
 * provider 实例并缓存（createRoutingAiClient，见 t57 §3）。
 */

import type { AiProvider, AiTask, ChatMessage, ChatToolDefinition, ChatResponse, ToolCall } from '../ai-client/types.js';
import { buildProviderPayload, resolveAdapter } from './dispatcher.js';
import { providerError, type NormalizedRequest, type NormalizedResponse, type ProviderConfig, type ProviderError } from './types.js';
import { assertEndpointAllowed, parseAllowedCidrs, type AllowedCidr, type DnsLookup } from '../ssrf/endpoint-guard.js';
import { createLogger } from '../logger/index.js';

const DEFAULT_TIMEOUT_MS = 90_000;

/** L2 SAFETY_BLOCK 文案（契约 §3 L2）：复用 provider_down kind，retryable=false 防重试烧预算。 */
const SAFETY_BLOCK_MESSAGE = 'SAFETY_BLOCK: provider 端点被拒绝（内网/保留地址不可访问）';

const logger = createLogger();

/** 解析 PROVIDER_BASEURL_ALLOWED_IPS env（非法条目忽略 + warn；缺省全禁 fail-closed）。 */
function resolveAllowedCidrs(explicit: AllowedCidr[] | undefined): AllowedCidr[] {
  if (explicit) return explicit;
  const parsed = parseAllowedCidrs(process.env.PROVIDER_BASEURL_ALLOWED_IPS);
  for (const entry of parsed.invalid) {
    logger.warn(`PROVIDER_BASEURL_ALLOWED_IPS 非法条目已忽略：${entry}`);
  }
  return parsed.allowed;
}

export interface CreateLlmProviderOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** SSRF 守卫：白名单 CIDR（缺省从 PROVIDER_BASEURL_ALLOWED_IPS env 解析；空=全禁 fail-closed）。 */
  allowedCidrs?: AllowedCidr[];
  /** SSRF 守卫：DNS 解析注入（测试用；缺省 node dns all:true + verbatim）。 */
  dnsLookup?: DnsLookup;
}

export function createLlmProvider(
  config: ProviderConfig,
  options: CreateLlmProviderOptions = {},
): AiProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowedCidrs = resolveAllowedCidrs(options.allowedCidrs);
  const dnsLookup = options.dnsLookup;

  async function request(req: NormalizedRequest): Promise<NormalizedResponse> {
    const adapter = resolveAdapter(config.providerKind);
    const payload = buildProviderPayload(config.providerKind, req);
    const url = `${config.baseUrl.replace(/\/$/, '')}/${adapter.kind === 'anthropic' ? 'v1/messages' : 'chat/completions'}`;

    // L2 运行时守卫（契约 §3）：唯一 choke point——fetch 前对最终 URL 全量校验；
    // 存量坏行（修复前已入库）在此兜底拒绝，无需数据迁移。
    const guard = await assertEndpointAllowed(url, allowedCidrs, { dnsLookup });
    if (!guard.ok) {
      throw providerError('provider_down', 0, SAFETY_BLOCK_MESSAGE, false);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          ...(adapter.kind === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw providerError('timeout', 408, '请求超时', true);
      }
      throw providerError('provider_down', 0, `网络错误：${error instanceof Error ? error.message : String(error)}`, true);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw adapter.normalizeError(response.status, data);
    }
    return adapter.parseResponse(data);
  }

  function toAiError(error: unknown): ProviderError {
    return error as ProviderError;
  }

  /** 最近一次请求的厂商 usage（t69 采集用；无厂商返回时 undefined）。 */
  let lastUsage: NormalizedResponse['usage'];

  const provider: AiProvider & { lastUsage?: NormalizedResponse['usage'] } = {
    async run(task: AiTask) {
      try {
        const result = await request({
          model: config.model,
          messages: [
            { role: 'system', content: '你是教师 AI 工具平台的结构化解析器。只返回 JSON。' },
            { role: 'user', content: JSON.stringify(task.input) },
          ],
          temperature: 0,
        });
        lastUsage = result.usage;
        const content = stripCodeFence(result.content);
        return JSON.parse(content) as Record<string, unknown>;
      } catch (error) {
        throw toAiError(error);
      }
    },

    async chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ChatResponse> {
      try {
        const result = await request({ model: config.model, messages, tools, temperature: 0 });
        lastUsage = result.usage;
        return {
          content: result.content,
          toolCalls: result.toolCalls as ToolCall[] | undefined,
        };
      } catch (error) {
        throw toAiError(error);
      }
    },
  };
  // 暴露最近 usage（t69 采集：厂商返回优先；无则 estimateTokens 兜底）
  Object.defineProperty(provider, 'lastUsage', { get: () => lastUsage, enumerable: false });
  return provider;
}

function stripCodeFence(content: string): string {
  return content.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}
