import { vi } from 'vitest';
import type { AgentTurnDto, ConversationDetailDto } from '../../api/conversations';

export const detail = (id = 'one', status: 'active' | 'archived' = 'active'): ConversationDetailDto => ({
  id, displayTitle: `会话${id}`, status, summary: null, lastMessagePreview: null, lastTurnAt: null,
  createdAt: '2026-09-15T12:00:00Z', updatedAt: '2026-09-15T12:00:00Z', turnCount: 0,
});
export const userTurn = (id: string, content: string, conversationId = 'one'): AgentTurnDto => ({
  id, conversationId, kind: 'user', content, inputSource: 'text', createdAt: '2026-09-15T12:00:00Z',
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function makeTransport() {
  return { sendMessage: vi.fn(), getTasks: vi.fn().mockResolvedValue([]), resumeTask: vi.fn() };
}
