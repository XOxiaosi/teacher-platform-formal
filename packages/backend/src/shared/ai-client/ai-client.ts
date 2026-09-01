import { ok, err, internalError, validationError } from '@teacher-platform/contracts';
import type { AiClient, AiTask, ChatMessage, ChatToolDefinition, CreateAiClientOptions } from './types.js';

export function createAiClient(options: CreateAiClientOptions): AiClient {
  return {
    async run(task: AiTask) {
      const validation = validateTask(task);
      if (!validation.ok) return validation;

      try {
        const output = await options.provider.run(task);
        return ok(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`AI 调用失败：${message}`));
      }
    },

    async chat(messages: ChatMessage[], tools: ChatToolDefinition[]) {
      if (!Array.isArray(messages) || messages.length === 0) {
        return err(validationError('messages 不能为空数组', 'messages'));
      }
      if (!Array.isArray(tools)) {
        return err(validationError('tools 必须是数组', 'tools'));
      }

      if (!options.provider.chat) {
        return err(internalError('当前 AI provider 不支持 chat'));
      }

      try {
        const response = await options.provider.chat(messages, tools);
        return ok(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(internalError(`AI chat 调用失败：${message}`));
      }
    },
  };
}

function validateTask(task: AiTask) {
  if (!task.input) {
    return err(validationError('AI 输入不能为空', 'input'));
  }
  return ok(true);
}
