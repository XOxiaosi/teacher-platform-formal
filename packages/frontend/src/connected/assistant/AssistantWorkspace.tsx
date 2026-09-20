import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ConversationStatus, ConversationSummaryDto } from '../../api/conversations';
import { readDraft, retainOnlyTeacherDrafts, writeDraft, type AssistantDraft } from './drafts';
import { AssistantComposer } from './AssistantComposer';
import { ConversationPanel } from './ConversationPanel';
import { useConversationList } from './useConversationList';
import { useAssistantMessages } from './useAssistantMessages';
import type { AssistantTransport } from './transport';
import './assistant.css';
import { formatDateTime } from '../../shared/date-format';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { History, MessageSquarePlus, Sparkles } from 'lucide-react';

interface Props {
  teacherId: string;
  transport?: AssistantTransport;
  /** Reload formal workspace data after a durable assistant outcome. */
  onWorkspaceRefresh?: () => Promise<void>;
}

const EMPTY_DRAFT_SCOPE = '__new_conversation__';

function routeConversation(): string | null {
  const match = /^#\/agent\/([^/?#]+)$/.exec(window.location.hash);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}

function ConversationHistory({ open, onOpenChange, historyButtonRef, items, status, busy, error, cursor, currentId, creating, onStatusChange, onSelect, onLoad, onCreate }: {
  open: boolean; onOpenChange: (open: boolean) => void; items: ConversationSummaryDto[]; status: ConversationStatus; busy: boolean; error: string; cursor: string | null; currentId: string | null; creating: boolean;
  historyButtonRef: RefObject<HTMLButtonElement | null>; onStatusChange: (status: ConversationStatus) => void; onSelect: (id: string) => void; onLoad: (append?: boolean) => void; onCreate: () => void;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="left" className="assistant-history-sheet" onCloseAutoFocus={event => { event.preventDefault(); historyButtonRef.current?.focus(); }}>
      <SheetHeader><SheetTitle>历史会话</SheetTitle><SheetDescription>找到已保存的工作，继续原来的上下文。</SheetDescription></SheetHeader>
      <div className="assistant-history-content">
        <Button type="button" className="assistant-history-create" disabled={creating} onClick={onCreate}><MessageSquarePlus size={16} />新对话</Button>
        <label className="assistant-history-filter">查看会话
          <select value={status} onChange={event => onStatusChange(event.target.value as ConversationStatus)}>
            <option value="active">进行中的会话</option><option value="archived">已归档的会话</option>
          </select>
        </label>
        {busy && <p role="status">正在读取会话列表…</p>}
        {error && <div className="assistant-history-error" role="alert"><p>{error}</p><Button type="button" size="sm" variant="outline" onClick={() => onLoad()}>重试读取列表</Button></div>}
        {!busy && !error && items.length === 0 && <p className="assistant-history-empty">{status === 'archived' ? '还没有已归档会话。' : '还没有已保存会话。'}</p>}
        <ul className="assistant-history-list">{items.map(item => <li key={item.id}>
          <button type="button" aria-current={currentId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
            <strong>{item.displayTitle}</strong>{item.summary && <span>{item.summary}</span>}<small>{item.lastTurnAt ? formatDateTime(item.lastTurnAt) : '尚无消息'}</small>
          </button>
        </li>)}</ul>
        {cursor && <Button type="button" variant="ghost" disabled={busy} onClick={() => onLoad(true)}>加载更多会话</Button>}
      </div>
    </SheetContent>
  </Sheet>;
}

function AssistantActions({ onHistory, onNew, historyButtonRef }: { onHistory: () => void; onNew: () => void; historyButtonRef: RefObject<HTMLButtonElement | null> }) {
  return <div className="assistant-topbar-actions">
    <Button ref={historyButtonRef} type="button" variant="ghost" size="sm" onClick={onHistory}><History size={16} />历史</Button>
    <Button type="button" variant="ghost" size="sm" onClick={onNew}><MessageSquarePlus size={16} />新对话</Button>
  </div>;
}

function AccountWorkspace({ teacherId, transport, onWorkspaceRefresh }: Props) {
  const [conversationId, setConversationId] = useState(routeConversation);
  const [status, setStatus] = useState<ConversationStatus>('active');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [startError, setStartError] = useState('');
  const navigationVersion = useRef(0);
  const startLock = useRef(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const list = useConversationList(teacherId, status, transport);
  const { messages, send } = useAssistantMessages(teacherId, transport);
  useEffect(() => { retainOnlyTeacherDrafts(teacherId); }, [teacherId]);
  useEffect(() => {
    const onHash = () => { navigationVersion.current += 1; setConversationId(routeConversation()); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = (id: string) => {
    navigationVersion.current += 1;
    window.location.hash = `/agent/${encodeURIComponent(id)}`;
    setConversationId(id);
    setHistoryOpen(false);
  };
  const openHistory = () => {
    setHistoryOpen(true);
    // Conversation summaries are derived data. Refresh when the sheet opens so
    // the newest turn is visible after a teacher has continued a conversation.
    void list.load();
  };
  const startNew = () => {
    navigationVersion.current += 1;
    window.location.hash = '#/agent';
    setConversationId(null);
    setStatus('active');
    setStartError('');
    setHistoryOpen(false);
  };
  const startFromDraft = async (draft: AssistantDraft) => {
    if (startLock.current || list.creating || !draft.text.trim()) return;
    startLock.current = true;
    const requestedAtVersion = navigationVersion.current;
    setStatus('active');
    setStartError('');
    try {
      const id = await list.create();
      if (!id) {
        setStartError('新会话未能创建，请重试。');
        return;
      }
      // Bind the first request to its new conversation before calling the shared
      // idempotent sender. Later edits in the blank composer remain untouched.
      writeDraft(teacherId, id, draft);
      if (readDraft(teacherId, EMPTY_DRAFT_SCOPE).requestId === draft.requestId) {
        writeDraft(teacherId, EMPTY_DRAFT_SCOPE, { text: '', requestId: crypto.randomUUID() });
      }
      if (navigationVersion.current === requestedAtVersion) select(id);
      void send(id, draft);
    } finally { startLock.current = false; }
  };
  return <TooltipProvider delayDuration={350}><div className="assistant-workspace">
    <div className="assistant-chat-shell">
      {conversationId
        ? <ConversationPanel key={conversationId} teacherId={teacherId} conversationId={conversationId} transport={transport} messageState={messages[conversationId]} send={send} onArchive={() => { void list.load(); }} onWorkspaceRefresh={onWorkspaceRefresh} headerActions={<AssistantActions onHistory={openHistory} onNew={startNew} historyButtonRef={historyButtonRef} />} />
        : <><header className="assistant-topbar"><div className="assistant-brand"><span><Sparkles size={16} /></span><strong>教学助手</strong></div><AssistantActions onHistory={openHistory} onNew={startNew} historyButtonRef={historyButtonRef} /></header><section className="assistant-welcome" aria-label="开始与教学助手对话">
          <div className="assistant-welcome-copy"><span className="assistant-welcome-orb"><Sparkles size={22} /></span><h1>今天想一起完成什么？</h1><p>直接说出你的目标，我会结合当前会话继续推进。</p></div>
          <AssistantComposer teacherId={teacherId} draftScope={EMPTY_DRAFT_SCOPE} available={Boolean(transport)} busy={list.creating} error={startError} onSend={startFromDraft} welcome />
        </section></>}
    </div>
    <ConversationHistory open={historyOpen} onOpenChange={setHistoryOpen} historyButtonRef={historyButtonRef} items={list.items} status={status} busy={list.busy} error={list.error} cursor={list.cursor} currentId={conversationId} creating={list.creating} onStatusChange={setStatus} onSelect={select} onLoad={append => { void list.load(append); }} onCreate={startNew} />
  </div></TooltipProvider>;
}

export function AssistantWorkspace(props: Props) { return <AccountWorkspace key={props.teacherId} {...props} />; }
