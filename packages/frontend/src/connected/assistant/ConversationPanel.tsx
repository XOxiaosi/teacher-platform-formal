import { useEffect, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { taskLabels, type AssistantTransport } from './transport';
import type { MessageState } from './useAssistantMessages';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>; onArchive: () => void;
}
export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onArchive }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const [draft, setDraft] = useState(() => readDraft(teacherId, conversationId));
  useEffect(() => { setDraft(readDraft(teacherId, conversationId)); }, [teacherId, conversationId, messageState?.acceptedRequestId]);
  const tasks = session.tasks.length ? session.tasks : messageState?.task ? [messageState.task] : [];
  const changeDraft = (text: string) => {
    const next = { text, requestId: crypto.randomUUID() };
    setDraft(next); writeDraft(teacherId, conversationId, next);
  };
  return <section className="assistant-conversation" aria-label="当前会话">
    <header className="assistant-conversation-heading">
      <h2>{session.conversation?.displayTitle ?? '读取会话'}</h2>
      {session.conversation?.status === 'active' && <button type="button" disabled={session.archiving || messageState?.sending} onClick={() => { void session.archive().then(saved => { if (saved) onArchive(); }); }}>{session.archiving ? '归档中…' : '归档会话'}</button>}
      {session.conversation?.status === 'archived' && <span>已归档 · 可完整回看</span>}
    </header>
    {session.busy && <p role="status">正在读取会话…</p>}
    {session.error && <div role="alert"><p>{session.error}</p><button type="button" disabled={session.busy} onClick={() => { void session.load(); }}>重新读取会话</button></div>}
    {session.conversation && <>
      <section className="assistant-tasks" aria-label="任务进度" aria-live="polite">
        {tasks.map(task => <article key={task.id}><strong>{taskLabels[task.status]}</strong><p>{task.summary}</p>
          {task.canResume && transport?.resumeTask && <button type="button" disabled={session.resumingTaskId !== null}
            onClick={() => { void session.resumeTask(task); }}>{session.resumingTaskId === task.id ? '正在恢复…' : '继续处理'}</button>}
        </article>)}
        {session.taskError && <p role="alert">{session.taskError}</p>}
        {transport?.getTasks && <button type="button" onClick={() => { void session.reloadTasks(); void session.load(); }}>刷新任务和结果</button>}
      </section>
      {session.events.length > 0 && <section className="assistant-task-events" aria-label="任务进展记录">
        <h3>任务进展记录</h3>
        <ol>{session.events.map(event => <li key={event.eventKey}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time> <span>{event.content}</span></li>)}</ol>
      </section>}
      {session.previousCursor && <button type="button" disabled={session.loadingHistory || session.busy} onClick={() => { void session.loadOlder(); }}>{session.loadingHistory ? '正在加载较早内容…' : '加载较早内容'}</button>}
      <div className="assistant-turns" aria-label="会话内容">{session.turns.map(turn => <TurnContent key={turn.id} turn={turn} />)}</div>
      {!session.busy && session.turns.length === 0 && <p>这条会话还没有消息。可以从整理课堂记录或核对课时开始。</p>}
      {session.conversation.status === 'active' && <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(conversationId, draft); }}>
        <label htmlFor="assistant-message">交给教学助手的工作</label>
        <textarea id="assistant-message" rows={4} value={draft.text} disabled={messageState?.sending} onChange={event => changeDraft(event.target.value)} placeholder="例如：整理今天的上课记录，核对课时，再写给家长的反馈" />
        <p className="assistant-hint">未发送的输入仅暂存在当前浏览器会话中，退出账号后清除。</p>
        {messageState?.error && <p role="alert">{messageState.error}</p>}
        {messageState?.sending && <p role="status">正在提交，等待接收回执…</p>}
        <button type="submit" disabled={!transport || !draft.text.trim() || messageState?.sending || session.busy}>{messageState?.sending ? '提交中…' : messageState?.error ? '重试发送' : '发送'}</button>
      </form>}
    </>}
  </section>;
}
