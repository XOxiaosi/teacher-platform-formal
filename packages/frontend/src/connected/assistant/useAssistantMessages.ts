import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import type { AssistantTask, AssistantTransport } from './transport';

export interface MessageState { sending?: boolean; error?: string; acceptedRequestId?: string; task?: AssistantTask }
export function useAssistantMessages(teacherId: string, transport?: AssistantTransport) {
  const [messages, setMessages] = useState<Record<string, MessageState>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function send(conversationId: string, draft: AssistantDraft) {
    if (!transport || pending.current.has(conversationId) || !draft.text.trim()) return;
    // Persist the original request before the network call. A lost response must
    // remain retryable with exactly the same payload even after a remount.
    const stored = readDraft(teacherId, conversationId);
    const submission = stored.awaitingReceipt ? stored : { ...draft, awaitingReceipt: true };
    writeDraft(teacherId, conversationId, submission);
    pending.current.add(conversationId);
    setMessages(previous => ({ ...previous, [conversationId]: { ...previous[conversationId], sending: true, error: '' } }));
    try {
      const receipt = await transport.sendMessage({ teacherId, conversationId, message: submission.text, clientRequestId: submission.requestId });
      if (!receipt.accepted) throw new Error('Missing durable receipt');
      if (!alive.current) return;
      if (readDraft(teacherId, conversationId).requestId === submission.requestId) {
        writeDraft(teacherId, conversationId, { text: '', requestId: crypto.randomUUID() });
      }
      setMessages(previous => ({ ...previous, [conversationId]: { sending: false, task: receipt.task, acceptedRequestId: submission.requestId } }));
    } catch (failure) {
      // Only a first-attempt, explicit validation rejection proves this message
      // was not accepted. A retry after an uncertain response stays fenced.
      const rejected = !stored.awaitingReceipt && failure instanceof ApiError
        && failure.status === 400 && failure.error.code === 'VALIDATION_ERROR';
      if (alive.current && rejected && readDraft(teacherId, conversationId).requestId === submission.requestId) {
        writeDraft(teacherId, conversationId, { text: submission.text, requestId: submission.requestId });
      }
      if (alive.current) setMessages(previous => ({ ...previous, [conversationId]: {
        ...previous[conversationId], sending: false, error: rejected
          ? '这条消息未被接收，输入已保留。请核对内容后重试。'
          : '尚未取得接收回执，输入已保留。请重试确认接收情况。',
      } }));
    } finally { pending.current.delete(conversationId); }
  }
  return { messages, send };
}
