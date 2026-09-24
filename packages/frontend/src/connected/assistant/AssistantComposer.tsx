import { useLayoutEffect, useRef, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import type { MessageState } from './useAssistantMessages';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LoaderCircle, RotateCcw, Send } from 'lucide-react';

interface Props {
  teacherId: string;
  draftScope: string;
  messageState?: MessageState;
  available: boolean;
  busy?: boolean;
  error?: string;
  onSend: (draft: AssistantDraft) => void | Promise<void>;
  placeholder?: string;
  welcome?: boolean;
  suggestedDraft?: { draft: AssistantDraft; basedOnRequestId: string } | null;
}

export function AssistantComposer({ teacherId, draftScope, messageState, available, busy = false, error, onSend, placeholder = '说说你现在想处理的教学工作…', welcome = false, suggestedDraft }: Props) {
  const [draft, setDraft] = useState(() => readDraft(teacherId, draftScope));
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const appliedSuggestionId = useRef<string | null>(null);
  const submitting = Boolean(messageState?.sending || busy);
  const messageError = messageState?.error || error;
  useLayoutEffect(() => { setDraft(readDraft(teacherId, draftScope)); }, [teacherId, draftScope, busy, messageState?.acceptedRequestId, messageState?.sending]);
  useLayoutEffect(() => {
    if (!suggestedDraft || appliedSuggestionId.current === suggestedDraft.draft.requestId || messageState?.sending) return;
    const current = readDraft(teacherId, draftScope);
    appliedSuggestionId.current = suggestedDraft.draft.requestId;
    if (current.requestId !== suggestedDraft.basedOnRequestId || current.awaitingReceipt) return;
    setDraft(suggestedDraft.draft);
    writeDraft(teacherId, draftScope, suggestedDraft.draft);
    composerRef.current?.focus();
  }, [draftScope, messageState?.sending, suggestedDraft, teacherId]);
  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(Math.max(element.scrollHeight, welcome ? 106 : 54), welcome ? 220 : 180)}px`;
  };
  useLayoutEffect(() => { if (composerRef.current) resize(composerRef.current); }, [draft.text, welcome]);
  const changeDraft = (text: string) => {
    if (draft.awaitingReceipt || messageState?.sending) return;
    const next = { text, requestId: crypto.randomUUID() };
    setDraft(next);
    writeDraft(teacherId, draftScope, next);
  };
  const submit = () => {
    if (!available || !draft.text.trim() || submitting) return;
    void onSend(draft);
  };
  return <form className={`assistant-composer${welcome ? ' assistant-composer-welcome' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
    <label className="sr-only" htmlFor={`assistant-message-${draftScope}`}>交给教学助手的工作</label>
    <div className="assistant-composer-box">
      <Textarea ref={composerRef} id={`assistant-message-${draftScope}`} rows={welcome ? 4 : 2} value={draft.text} disabled={messageState?.sending} readOnly={draft.awaitingReceipt}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!draft.awaitingReceipt) submit();
        }}
        onChange={event => changeDraft(event.target.value)} onInput={event => resize(event.currentTarget)} placeholder={placeholder} />
      <div className="assistant-composer-footer">
        <span>Enter 发送 · Shift + Enter 换行</span>
        <Button type="submit" aria-label={submitting ? '提交中' : messageError || draft.awaitingReceipt ? '重试发送' : '发送'} disabled={!available || !draft.text.trim() || submitting}>{submitting ? <><LoaderCircle className="assistant-spin" size={16} /><span className="sr-only">{busy && !messageState?.sending ? '正在创建会话' : '正在提交'}</span></> : messageError || draft.awaitingReceipt ? <><RotateCcw size={16} /><span className="sr-only">重试发送</span></> : <Send size={17} />}</Button>
      </div>
    </div>
    <p className="assistant-hint">未发送的输入仅暂存在当前浏览器会话中，退出账号后清除。</p>
    {draft.awaitingReceipt && !messageState?.sending && <p role="status">这条消息的接收情况尚未确认。请先重试确认接收，再编辑；重试不会重复提交同一项工作。</p>}
    {messageError && <p role="alert">{messageError}</p>}
    {messageState?.sending && <p role="status">正在提交，等待接收回执…</p>}
  </form>;
}
