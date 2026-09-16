import { useEffect, useRef, useState } from 'react';
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
    pending.current.add(conversationId);
    setMessages(previous => ({ ...previous, [conversationId]: { ...previous[conversationId], sending: true, error: '' } }));
    try {
      const receipt = await transport.sendMessage({ teacherId, conversationId, message: draft.text, clientRequestId: draft.requestId });
      if (!receipt.accepted) throw new Error('Missing durable receipt');
      if (!alive.current) return;
      if (readDraft(teacherId, conversationId).requestId === draft.requestId) {
        writeDraft(teacherId, conversationId, { text: '', requestId: crypto.randomUUID() });
      }
      setMessages(previous => ({ ...previous, [conversationId]: { sending: false, task: receipt.task, acceptedRequestId: draft.requestId } }));
    } catch {
      if (alive.current) setMessages(previous => ({ ...previous, [conversationId]: {
        ...previous[conversationId], sending: false, error: '尚未取得接收回执，输入已保留。请重试确认接收情况。',
      } }));
    } finally { pending.current.delete(conversationId); }
  }
  return { messages, send };
}
