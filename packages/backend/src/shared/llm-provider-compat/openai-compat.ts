/**
 * OpenAI Chat Completions 兼容适配器（P7 渠道线 · t60，t57 设计 §1.2/§1.3）。
 *
 * 默认/兜底协议——覆盖 DeepSeek、通义（DashScope 兼容模式）、智谱、豆包/火山方舟、
 * 月之暗面、硅基流动等绝大多数国内厂商（均为 /chat/completions 兼容）。
 *
 * payload 转换：
 * - messages 直通（ChatMessage 与 OpenAI messages 同构，system/user/assistant+tool_calls/tool）；
 * - tools → {type:'function', function:{name,description,parameters}}；
 * - 响应 choices[0].message.content + tool_calls[].function.arguments；
 * - 参数白名单清洗（智谱部分模型 temperature 差异：非法值剥除）。
 */

import type {
  ChatMessage,
  NormalizedRequest,
  NormalizedResponse,
  ProtocolAdapter,
  ProviderConfig,
} from './types.js';
import { providerError, type ProviderError } from './types.js';

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type?: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  error?: { message?: string; code?: string };
}

interface OpenAiResponseMessage {
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

/** 请求参数白名单（厂商差异清洗：非法/不支持参数剥除，不改语义）。 */
const ALLOWED_TOP_LEVEL_PARAMS = new Set([
  'model', 'messages', 'temperature', 'tools', 'tool_choice',
  'max_tokens', 'stream', 'top_p', 'stop',
]);

function cleanParameters(payload: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_TOP_LEVEL_PARAMS.has(key)) continue;
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function serializeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: message.role,
        content: message.content,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args),
          },
        })),
      };
    }
    if (message.role === 'tool') {
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseToolCalls(message: OpenAiResponseMessage | undefined) {
  if (!message?.tool_calls || message.tool_calls.length === 0) return undefined;
  const toolCalls = message.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function.name, args };
  });
  return toolCalls;
}

/** L3 反射收口（契约 §3）：剥离控制字符 + 截断 ≤200 字符（防响应体 error.message 外带/日志注入）。 */
function sanitizeReflectedMessage(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

function normalizeError(status: number, data: unknown): ProviderError {
  const message = sanitizeReflectedMessage(
    (data && typeof data === 'object' && 'error' in data
      && data.error && typeof data.error === 'object' && 'message' in data.error
      ? String((data.error as { message: unknown }).message)
      : '') || `OpenAI 兼容 HTTP ${status}`,
  );

  if (status === 401 || status === 403) return providerError('auth', status, `认证失败：${message}`);
  if (status === 429) return providerError('rate_limited', status, `限流：${message}`, true);
  if (status === 404) return providerError('model_not_found', status, `模型不存在：${message}`);
  if (status === 400 || status === 422) return providerError('invalid_request', status, `请求无效：${message}`);
  if (status >= 500) return providerError('provider_down', status, `厂商服务异常：${message}`, true);
  return providerError('unknown', status, message);
}

export function createOpenAiCompatAdapter(): ProtocolAdapter {
  return {
    kind: 'openai',
    matches(_config: ProviderConfig) {
      return true; // 默认兜底：任何未命中 anthropic 的 providerKind 都走 OpenAI 兼容
    },
    buildPayload(req: NormalizedRequest): unknown {
      const payload: Record<string, unknown> = {
        model: req.model,
        messages: serializeMessages(req.messages),
        temperature: req.temperature ?? 0,
      };
      if (req.tools && req.tools.length > 0) {
        payload.tools = req.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      if (req.stream) payload.stream = true;
      return cleanParameters(payload);
    },
    parseResponse(data: unknown): NormalizedResponse {
      const parsed = data as OpenAiChatCompletionResponse;
      const message = parsed.choices?.[0]?.message;
      return {
        content: message?.content ?? '',
        toolCalls: parseToolCalls(message),
        usage: extractUsage(data),
      };
    },
    normalizeError,
  };
}

function extractUsage(data: unknown): NormalizedResponse['usage'] | undefined {
  if (data && typeof data === 'object' && 'usage' in data) {
    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
      return {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      };
    }
  }
  return undefined;
}
