import { useEffect, useRef, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { AssistantComposer } from './AssistantComposer';
import { ConversationPanel } from './ConversationPanel';
import { useConversationList } from './useConversationList';
import { useAssistantMessages } from './useAssistantMessages';
import type { AssistantTransport } from './transport';
import './assistant.css';
import { Button } from '@/components/ui/button';
import { LoaderCircle, Sparkles } from 'lucide-react';

interface Props {
  teacherId: string;
  transport?: AssistantTransport;
  /** Isolated review views may show in-memory actions; formal views keep test-only confirmations read-only. */
  presentationMode?: 'formal' | 'sample';
  /** Reload formal workspace data after a durable assistant outcome. */
  onWorkspaceRefresh?: () => Promise<void>;
}

const EMPTY_DRAFT_SCOPE = '__persistent_conversation__';

function AssistantHeader() {
  return <header className="assistant-topbar">
    <div className="assistant-brand"><span><Sparkles size={16} /></span><strong>教学助手</strong></div>
  </header>;
}

function Welcome({ teacherId, available, busy, error, onSend }: {
  teacherId: string;
  available: boolean;
  busy: boolean;
  error: string;
  onSend: (draft: AssistantDraft) => Promise<void>;
}) {
  return <section className="assistant-welcome" aria-label="教学助手对话">
    <div className="assistant-welcome-copy"><span className="assistant-welcome-orb"><Sparkles size={22} /></span><h1>今天想一起完成什么？</h1><p>直接说出目标，我会结合已有对话继续处理。</p></div>
    <AssistantComposer teacherId={teacherId} draftScope={EMPTY_DRAFT_SCOPE} available={available} busy={busy} error={error} onSend={onSend} welcome />
  </section>;
}

function AccountWorkspace({ teacherId, transport, presentationMode = 'formal', onWorkspaceRefresh }: Props) {
  const list = useConversationList(teacherId, 'active', transport);
  const { messages, send } = useAssistantMessages(teacherId, transport);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationResolved, setConversationResolved] = useState(false);
  const [startError, setStartError] = useState('');
  const startLock = useRef(false);

  useEffect(() => {
    if (list.busy || !list.loaded || list.error || conversationResolved) return;
    setConversationResolved(true);
    const latest = list.items[0];
    if (latest) setConversationId(latest.id);
  }, [conversationResolved, list.busy, list.error, list.items, list.loaded]);

  const startFromDraft = async (draft: AssistantDraft) => {
    if (startLock.current || list.creating || !draft.text.trim()) return;
    startLock.current = true;
    setStartError('');
    try {
      const id = await list.create();
      if (!id) {
        setStartError('暂时无法开始对话，请重新读取后再试。');
        return;
      }
      writeDraft(teacherId, id, draft);
      if (readDraft(teacherId, EMPTY_DRAFT_SCOPE).requestId === draft.requestId) {
        writeDraft(teacherId, EMPTY_DRAFT_SCOPE, { text: '', requestId: crypto.randomUUID() });
      }
      setConversationId(id);
      setConversationResolved(true);
      await send(id, draft);
    } finally {
      startLock.current = false;
    }
  };

  const retryList = () => {
    setConversationResolved(false);
    setConversationId(null);
    void list.load();
  };

  return <div className="assistant-workspace">
    <AssistantHeader />
    <div className="assistant-chat-shell">
      {list.busy || !list.loaded
        ? <section className="assistant-loading-state" role="status"><LoaderCircle size={17} className="assistant-spin" />正在载入对话…</section>
        : list.error
          ? <section className="assistant-load-error" role="alert"><p>暂时无法读取已有对话，内容没有更改。</p><Button type="button" variant="outline" onClick={retryList}>重新读取</Button></section>
          : !conversationResolved
            ? <section className="assistant-loading-state" role="status"><LoaderCircle size={17} className="assistant-spin" />正在载入对话…</section>
            : conversationId
            ? <ConversationPanel teacherId={teacherId} conversationId={conversationId} transport={transport} presentationMode={presentationMode} messageState={messages[conversationId]} send={send} onWorkspaceRefresh={onWorkspaceRefresh} />
            : <Welcome teacherId={teacherId} available={Boolean(transport)} busy={list.creating} error={startError} onSend={startFromDraft} />}
    </div>
  </div>;
}

export function AssistantWorkspace(props: Props) { return <AccountWorkspace key={props.teacherId} {...props} />; }
