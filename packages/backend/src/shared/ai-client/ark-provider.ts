import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiProvider, AiTask, ChatMessage, ChatToolDefinition, ChatResponse, ToolCall } from './types.js';

export interface ArkProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

export function createArkAiProvider(options: ArkProviderOptions): AiProvider {
  return {
    async run(task) {
      const response = await fetch(`${trimSlash(options.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages: buildMessages(task),
          temperature: 0,
        }),
      });

      const data = await response.json() as ChatCompletionResponse;
      if (!response.ok) throw new Error(data.error?.message ?? `Ark HTTP ${response.status}`);

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Ark 返回内容为空');
      return parseJsonContent(content);
    },

    async chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ChatResponse> {
      const response = await fetch(`${trimSlash(options.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages: serializeChatMessages(messages),
          temperature: 0,
          tools: tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      });

      const data = await response.json() as ChatCompletionResponse;
      if (!response.ok) throw new Error(data.error?.message ?? `Ark HTTP ${response.status}`);

      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('Ark 返回内容为空');

      const content = message.content ?? '';
      let toolCalls: ToolCall[] | undefined;

      if (message.tool_calls && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((tc) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            throw new Error(`工具 ${tc.function.name} 参数解析失败`);
          }
          return {
            id: tc.id,
            name: tc.function.name,
            args,
          };
        });
      }

      return { content, toolCalls };
    },
  };
}

export function createArkAiProviderFromEnv(): AiProvider {
  loadEnvFromNearestFile();
  const apiKey = process.env.ARK_API_KEY;
  const baseUrl = process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3';
  const model = process.env.ARK_MODEL ?? 'doubao-seed-2.0-pro';
  if (!apiKey) {
    return { async run() { throw new Error('缺少 ARK_API_KEY'); } };
  }
  return createArkAiProvider({ apiKey, baseUrl, model });
}

/**
 * Local-safe mode must not route an AI request to a provider even if the host
 * process happens to contain provider credentials.  Returning a provider that
 * always rejects preserves the normal Result error path without pretending a
 * local response was generated.
 */
export function createFailClosedAiProvider(
  message = '本机安全模式未启用 AI 供应商',
): AiProvider {
  return {
    async run() {
      throw new Error(message);
    },
    async chat() {
      throw new Error(message);
    },
  };
}

function serializeChatMessages(messages: ChatMessage[]) {
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

function buildMessages(task: AiTask) {
  return [
    {
      role: 'system',
      content: [
        '你是教师 AI 工具平台的结构化解析器。',
        '只返回 JSON，不要解释，不要 Markdown。',
        'intent 只能是 schedule_create, schedule_modify, schedule_query, lesson_record, student_update, review_input, general_note。',
      ].join('\n'),
    },
    { role: 'user', content: buildPrompt(task) },
  ];
}

function buildPrompt(task: AiTask): string {
  const input = JSON.stringify(task.input);
  if (task.taskType === 'intent_recognition') {
    return `识别输入意图，返回 {"intent": string, "confidenceScore": number}。输入：${input}`;
  }
  if (task.taskType === 'information_extraction') {
    return [
      '抽取教师工作流字段。',
      '返回 JSON，可包含 studentName, timeText, type, durationMinutes, location, courseContent, studentState, homework, intent。',
      `输入：${input}`,
    ].join('\n');
  }
  return `如果输入中已有 text，返回 {"text": text}；否则返回 {"text": ""}。输入：${input}`;
}

function parseJsonContent(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function loadEnvFromNearestFile(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadEnv(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function loadEnv(path: string): void {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
}
