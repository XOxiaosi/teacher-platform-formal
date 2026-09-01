/**
 * Anthropic Messages 协议适配器（P7 渠道线 · t60，t57 设计 §1.2）。
 *
 * payload 转换（/v1/messages）：
 * - system 拆出为顶层字段（content blocks 形式亦可，取字符串简化）；
 * - user/assistant → content blocks；assistant 的 tool 请求 → tool_use block
 *   （id/name/input）；tool 结果 → tool_result block（tool_use_id/content）；
 * - 响应 content[] 中 text 块拼 content、tool_use[] → ToolCall；
 * - usage.input_tokens/output_tokens → prompt/completion tokens。
 */

import type {
  ChatMessage,
  NormalizedRequest,
  NormalizedResponse,
  ProtocolAdapter,
  ProviderConfig,
} from './types.js';
import { providerError, type ProviderError } from './types.js';

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/** 将内部 ChatMessage 转为 Anthropic content blocks。 */
function toContentBlocks(message: ChatMessage): unknown[] {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const toolCall of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.args,
      });
    }
    return blocks;
  }
  if (message.role === 'tool') {
    return [{
      type: 'tool_result',
      tool_use_id: message.toolCallId ?? '',
      content: message.content,
    }];
  }
  return [{ type: 'text', text: message.content }];
}

function toAnthropicMessage(message: ChatMessage): { role: string; content: unknown[] } {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: toContentBlocks(message),
  };
}

function parseContentBlocks(content: AnthropicMessageResponse['content']): {
  text: string;
  toolCalls?: NormalizedResponse['toolCalls'];
} {
  let text = '';
  const toolCalls: NonNullable<NormalizedResponse['toolCalls']> = [];
  for (const block of content ?? []) {
    if (block.type === 'text' && block.text) text += block.text;
    if (block.type === 'tool_use' && block.id) {
      toolCalls.push({
        id: block.id,
        name: block.name ?? '',
        args: (block.input && typeof block.input === 'object'
          ? block.input as Record<string, unknown>
          : {}),
      });
    }
  }
  return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
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
      : '') || `Anthropic HTTP ${status}`,
  );

  if (status === 401 || status === 403) return providerError('auth', status, `认证失败：${message}`);
  if (status === 429) return providerError('rate_limited', status, `限流：${message}`, true);
  if (status === 404) return providerError('model_not_found', status, `模型不存在：${message}`);
  if (status === 400 || status === 422) return providerError('invalid_request', status, `请求无效：${message}`);
  if (status >= 500) return providerError('provider_down', status, `厂商服务异常：${message}`, true);
  return providerError('unknown', status, message);
}

export function createAnthropicAdapter(): ProtocolAdapter {
  return {
    kind: 'anthropic',
    matches(config: ProviderConfig) {
      return config.providerKind === 'anthropic'
        || config.providerName.toLowerCase() === 'anthropic'
        || config.providerName.toLowerCase() === 'claude';
    },
    buildPayload(req: NormalizedRequest): unknown {
      const system = req.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const messages = req.messages
        .filter((message) => message.role !== 'system')
        .map(toAnthropicMessage);

      const payload: Record<string, unknown> = {
        model: req.model,
        messages,
        max_tokens: 4096,
        temperature: req.temperature ?? 0,
      };
      if (system) payload.system = system;
      if (req.tools && req.tools.length > 0) {
        payload.tools = req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }));
      }
      return payload;
    },
    parseResponse(data: unknown): NormalizedResponse {
      const parsed = data as AnthropicMessageResponse;
      const { text, toolCalls } = parseContentBlocks(parsed.content);
      const usage = parsed.usage
        ? {
          promptTokens: parsed.usage.input_tokens ?? 0,
          completionTokens: parsed.usage.output_tokens ?? 0,
        }
        : undefined;
      return { content: text, toolCalls, usage };
    },
    normalizeError,
  };
}
