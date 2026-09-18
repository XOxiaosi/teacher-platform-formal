import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { taskLabels, type AssistantTransport } from './transport';
import type { AssistantTask, AssistantTaskEvent } from './transport';
import type { MessageState } from './useAssistantMessages';
import { formatDateTime } from '../../shared/date-format';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>; onArchive: () => void;
}
function compactTasks(tasks: AssistantTask[]): Array<{ task: AssistantTask; count: number }> {
  return tasks.reduce<Array<{ task: AssistantTask; count: number }>>((groups, task) => {
    const group = groups.find(item => item.task.status === task.status && item.task.summary === task.summary);
    if (group) group.count += 1;
    else groups.push({ task, count: 1 });
    return groups;
  }, []);
}

function eventLabel(event: AssistantTaskEvent): string {
  if (event.content.length > 180) return '助手已更新结果，详情见下方会话内容';
  return event.content;
}

function compactEvents(events: AssistantTaskEvent[]): Array<AssistantTaskEvent & { repeatCount?: number }> {
  return events.reduce<Array<AssistantTaskEvent & { repeatCount?: number }>>((visible, event) => {
    const previous = visible.at(-1);
    if (previous && previous.eventKind === event.eventKind && previous.content === event.content) {
      previous.repeatCount = (previous.repeatCount ?? 1) + 1;
      return visible;
    }
    visible.push({ ...event });
    return visible;
  }, []);
}

export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onArchive }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const [draft, setDraft] = useState(() => readDraft(teacherId, conversationId));
  const conversationBodyRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
  useEffect(() => { setDraft(readDraft(teacherId, conversationId)); }, [teacherId, conversationId, messageState?.acceptedRequestId, messageState?.sending]);
  useLayoutEffect(() => {
    const container = conversationBodyRef.current;
    if (!container || !keepAtBottom.current) return;
    container.scrollTop = container.scrollHeight;
  }, [session.turns, session.events, session.tasks, session.busy]);
  const tasks = session.tasks.length ? session.tasks : messageState?.task ? [messageState.task] : [];
  const visibleTasks = compactTasks(tasks);
  const visibleEvents = compactEvents(session.events);
  const syncStatus = session.syncing
    ? '正在同步…'
    : session.syncError
      ? '实时更新暂时中断，将自动重试'
      : session.lastSyncedAt
        ? `实时更新 · ${formatDateTime(session.lastSyncedAt)}`
        : '实时更新已开启';
  const changeDraft = (text: string) => {
    if (draft.awaitingReceipt || messageState?.sending) return;
    const next = { text, requestId: crypto.randomUUID() };
    setDraft(next); writeDraft(teacherId, conversationId, next);
  };
  return <section className="assistant-conversation" aria-label="当前会话">
    <header className="assistant-conversation-heading">
      <div className="assistant-conversation-title">
        <h2>{session.conversation?.displayTitle ?? '读取会话'}</h2>
        <p className={`assistant-sync-status${session.syncError ? ' is-error' : ''}`} role="status" aria-live="polite">
          <span className="assistant-sync-dot" aria-hidden="true" />{syncStatus}
        </p>
      </div>
      {session.conversation?.status === 'active' && <button type="button" disabled={session.archiving || messageState?.sending || draft.awaitingReceipt} onClick={() => { void session.archive().then(saved => { if (saved) onArchive(); }); }}>{session.archiving ? '归档中…' : '归档会话'}</button>}
      {session.conversation?.status === 'archived' && <span>已归档 · 可完整回看</span>}
    </header>
    <div className="assistant-conversation-body" ref={conversationBodyRef} onScroll={event => {
      const container = event.currentTarget;
      keepAtBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 72;
    }}>
      {session.busy && <p role="status">正在读取会话…</p>}
      {session.error && <div role="alert"><p>{session.error}</p><button type="button" disabled={session.busy} onClick={() => { void session.load(); }}>重新读取会话</button></div>}
      {session.conversation && <>
        <section className="assistant-tasks" aria-label="任务进度" aria-live="polite">
          {visibleTasks.map(({ task, count }) => <article key={`${task.status}:${task.summary}`}>
            <header><strong>{taskLabels[task.status]}</strong></header>
            <p>{task.summary}</p>
            {count > 1 && <small>相同状态已合并显示 · {count} 个任务仍可从下方会话内容回看</small>}
            {task.canResume && transport?.resumeTask && <button type="button" disabled={session.resumingTaskId !== null}
              onClick={() => { void session.resumeTask(task); }}>{session.resumingTaskId === task.id ? '正在恢复…' : '继续处理'}</button>}
          </article>)}
          {session.taskError && <p role="alert">{session.taskError}</p>}
          {transport?.getTasks && <button type="button" onClick={() => { void session.reloadTasks(); void session.load(); }}>刷新任务和结果</button>}
        </section>
        {visibleEvents.length > 0 && <section className="assistant-task-events" aria-label="任务进展记录">
          <h3>任务进展记录</h3>
          <ol>{visibleEvents.map(event => <li key={event.eventKey}><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time> <span>{eventLabel(event)}{event.repeatCount && event.repeatCount > 1 ? `（重复 ${event.repeatCount} 次，已合并）` : ''}</span></li>)}</ol>
        </section>}
        {session.previousCursor && <button type="button" disabled={session.loadingHistory || session.busy} onClick={() => { void session.loadOlder(); }}>{session.loadingHistory ? '正在加载较早内容…' : '加载较早内容'}</button>}
        <div className="assistant-turns" aria-label="会话内容">{session.turns.map(turn => <TurnContent key={turn.id} turn={turn} />)}</div>
        {!session.busy && session.turns.length === 0 && <p>这条会话还没有消息。可以从整理课堂记录或核对课时开始。</p>}
      </>}
    </div>
    {session.conversation?.status === 'active' && <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(conversationId, draft); }}>
      <label htmlFor="assistant-message">交给教学助手的工作</label>
      <textarea id="assistant-message" rows={4} value={draft.text} disabled={messageState?.sending} readOnly={draft.awaitingReceipt} onChange={event => changeDraft(event.target.value)} placeholder="例如：整理今天的上课记录，核对课时，再写给家长的反馈" />
      <p className="assistant-hint">未发送的输入仅暂存在当前浏览器会话中，退出账号后清除。</p>
      {draft.awaitingReceipt && !messageState?.sending && <p role="status">这条消息的接收情况尚未确认。请先重试确认接收，再编辑或归档；重试不会重复提交同一项工作。</p>}
      {messageState?.error && <p role="alert">{messageState.error}</p>}
      {messageState?.sending && <p role="status">正在提交，等待接收回执…</p>}
      <button type="submit" disabled={!transport || !draft.text.trim() || messageState?.sending || session.busy}>{messageState?.sending ? '提交中…' : messageState?.error || draft.awaitingReceipt ? '重试发送' : '发送'}</button>
    </form>}
  </section>;
}
