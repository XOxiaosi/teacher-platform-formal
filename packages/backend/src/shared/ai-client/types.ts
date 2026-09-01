import type { CommonError, Result } from '@teacher-platform/contracts';

export type AiTaskType = 'speech_to_text' | 'intent_recognition' | 'information_extraction';

export interface AiTask {
  taskType: AiTaskType;
  input: unknown;
}

export type AiOutput = Record<string, unknown>;

// ---- Chat 相关类型 ----

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
}

// ---- Provider / Client 接口 ----

export interface AiProvider {
  run(task: AiTask): Promise<AiOutput>;
  chat?(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ChatResponse>;
}

export interface AiClient {
  run(task: AiTask): Promise<Result<AiOutput, CommonError>>;
  chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<Result<ChatResponse, CommonError>>;
}

export interface CreateAiClientOptions {
  provider: AiProvider;
}
