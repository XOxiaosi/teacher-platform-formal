import type { CommonError, Result } from '@teacher-platform/contracts';

export interface SendMessageInput {
  to: string;
  content: string;
}

export interface SendMessageOutput {
  messageId: string;
}

export interface MessageTransport {
  send(input: SendMessageInput): Promise<SendMessageOutput>;
}

export interface MessageAdapter {
  send(input: SendMessageInput): Promise<Result<SendMessageOutput, CommonError>>;
}

export interface CreateMessageAdapterOptions {
  transport: MessageTransport;
}
