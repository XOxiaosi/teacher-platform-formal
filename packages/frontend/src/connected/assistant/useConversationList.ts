import { useEffect, useRef, useState } from 'react';
import { createConversation, getConversation, listConversations, type ConversationStatus, type ConversationSummaryDto } from '../../api/conversations';
import type { AssistantTransport } from './transport';

export function useConversationList(teacherId: string, status: ConversationStatus, transport?: AssistantTransport) {
  const [items, setItems] = useState<ConversationSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const lock = useRef(false);
  const createLock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function load(append = false) {
    if (lock.current) return;
    lock.current = true;
    const request = version.current;
    setBusy(true); setError('');
    try {
      const result = await listConversations(teacherId, { status, ...(append && cursor ? { cursor } : {}) });
      if (!alive.current || request !== version.current) return;
      setItems(previous => append ? [...previous, ...result.items.filter(item => !previous.some(old => old.id === item.id))] : result.items);
      setCursor(result.nextCursor);
    } catch { if (alive.current && request === version.current) setError('会话列表暂时无法读取，请重试。'); }
    finally { if (request === version.current) { lock.current = false; if (alive.current) setBusy(false); } }
  }
  useEffect(() => {
    version.current += 1; lock.current = false; setItems([]); setCursor(null);
    void load();
    return () => { version.current += 1; };
    // A new scope must discard old responses before fetching its first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, status]);
  async function create(): Promise<string | null> {
    if (createLock.current) return null;
    createLock.current = true; setCreating(true); setError('');
    try {
      const response = transport?.createConversation
        ? await getConversation(teacherId, await transport.createConversation({ teacherId }))
        : await createConversation(teacherId);
      const conversation = response.conversation;
      if (!alive.current) return null;
      if (status === 'active') setItems(previous => [conversation, ...previous.filter(item => item.id !== conversation.id)]);
      return conversation.id;
    } catch { if (alive.current) setError('新会话未能创建，请重试。'); return null; }
    finally { createLock.current = false; if (alive.current) setCreating(false); }
  }
  return { items, cursor, busy, creating, error, load, create };
}
