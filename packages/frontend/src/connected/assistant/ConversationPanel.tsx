import { useEffect, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { taskLabels, type AssistantTransport } from './transport';
import type { AssistantCapabilities, AssistantTask, AssistantTaskEvent } from './transport';
import type { MessageState } from './useAssistantMessages';
import { formatDateTime } from '../../shared/date-format';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>; onArchive: () => void;
}
const readOnlyCapabilities: AssistantCapabilities = { canRead: true, canWrite: false, writeRequiresConfirmation: true };

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

function PermissionSummary({ capabilities }: { capabilities: AssistantCapabilities }) {
  const canWrite = capabilities.canWrite;
  return <section className="assistant-permission" aria-label="本次会话权限">
    <header><h3>权限与下一步</h3><strong>{canWrite ? '可整理，变更需确认' : '只读查询与整理'}</strong></header>
    <dl>
      <div><dt>可以做</dt><dd>读取已有资料、核对信息、整理待处理草稿。</dd></div>
      <div><dt>正式写入</dt><dd>{canWrite ? '可提出待确认的学生、课程、课时或提醒变更。' : '本轮未开放；没有学生、课程、课时或提醒写入回执。'}</dd></div>
      <div><dt>下一步</dt><dd>{canWrite ? '先核对变更内容，再确认执行。' : '需要落库时，请切换到已开放写入的操作环境，并重新核对结果。'}</dd></div>
    </dl>
  </section>;
}

export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onArchive }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const [draft, setDraft] = useState(() => readDraft(teacherId, conversationId));
  useEffect(() => { setDraft(readDraft(teacherId, conversationId)); }, [teacherId, conversationId, messageState?.acceptedRequestId, messageState?.sending]);
  const tasks = session.tasks.length ? session.tasks : messageState?.task ? [messageState.task] : [];
  const visibleTasks = compactTasks(tasks);
  const visibleEvents = compactEvents(session.events);
  const capabilities = transport?.capabilities ?? readOnlyCapabilities;
  const changeDraft = (text: string) => {
    if (draft.awaitingReceipt || messageState?.sending) return;
    const next = { text, requestId: crypto.randomUUID() };
    setDraft(next); writeDraft(teacherId, conversationId, next);
  };
  return <section className="assistant-conversation" aria-label="当前会话">
    <header className="assistant-conversation-heading">
      <h2>{session.conversation?.displayTitle ?? '读取会话'}</h2>
      {session.conversation?.status === 'active' && <button type="button" disabled={session.archiving || messageState?.sending || draft.awaitingReceipt} onClick={() => { void session.archive().then(saved => { if (saved) onArchive(); }); }}>{session.archiving ? '归档中…' : '归档会话'}</button>}
      {session.conversation?.status === 'archived' && <span>已归档 · 可完整回看</span>}
    </header>
    {session.busy && <p role="status">正在读取会话…</p>}
    {session.error && <div role="alert"><p>{session.error}</p><button type="button" disabled={session.busy} onClick={() => { void session.load(); }}>重新读取会话</button></div>}
    {session.conversation && <>
      <PermissionSummary capabilities={capabilities} />
      <section className="assistant-tasks" aria-label="任务进度" aria-live="polite">
        {visibleTasks.map(({ task, count }) => <article key={`${task.status}:${task.summary}`}>
          <header><strong>{taskLabels[task.status]}</strong><span>结果范围：{capabilities.canWrite ? '查询与待确认变更' : '查询与整理'}</span></header>
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
      {session.conversation.status === 'active' && <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(conversationId, draft); }}>
        <label htmlFor="assistant-message">交给教学助手的工作</label>
        <textarea id="assistant-message" rows={4} value={draft.text} disabled={messageState?.sending} readOnly={draft.awaitingReceipt} onChange={event => changeDraft(event.target.value)} placeholder="例如：整理今天的上课记录，核对课时，再写给家长的反馈" />
        <p className="assistant-hint">未发送的输入仅暂存在当前浏览器会话中，退出账号后清除。</p>
        {draft.awaitingReceipt && !messageState?.sending && <p role="status">这条消息的接收情况尚未确认。请先重试确认接收，再编辑或归档；重试不会重复提交同一项工作。</p>}
        {messageState?.error && <p role="alert">{messageState.error}</p>}
        {messageState?.sending && <p role="status">正在提交，等待接收回执…</p>}
        <button type="submit" disabled={!transport || !draft.text.trim() || messageState?.sending || session.busy}>{messageState?.sending ? '提交中…' : messageState?.error || draft.awaitingReceipt ? '重试发送' : '发送'}</button>
      </form>}
    </>}
  </section>;
}
