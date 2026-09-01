import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
import type { CreateMessageAdapterOptions, MessageAdapter, SendMessageInput } from './message-types.js';

export function createMessageAdapter(options: CreateMessageAdapterOptions): MessageAdapter {
  return {
    async send(input: SendMessageInput) {
      const validation = validateMessage(input);
      if (!validation.ok) return validation;

      try {
        return ok(await options.transport.send(input));
      } catch (error) {
        return err(internalError(`消息发送失败：${errorMessage(error)}`));
      }
    },
  };
}

function validateMessage(input: SendMessageInput) {
  if (!input.to.trim()) return err(validationError('接收方不能为空', 'to'));
  if (!input.content.trim()) return err(validationError('消息内容不能为空', 'content'));
  return ok(true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
