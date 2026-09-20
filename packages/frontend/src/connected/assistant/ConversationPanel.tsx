import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { taskLabels, type AssistantTransport } from './transport';
import type { AssistantTask, AssistantTaskEvent } from './transport';
import type { MessageState } from './useAssistantMessages';
import { cancelPendingAction, confirmPendingAction, type AgentTurnDto, type ConfirmationStatus, type ConfirmationTurnDto, type UserTurnDto } from '../../api/conversations';
import { formatDateTime } from '../../shared/date-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Archive, ArrowDown, ChevronDown, CircleAlert, LoaderCircle, RotateCcw, Send, Sparkles } from 'lucide-react';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>; onArchive: () => void;
  onWorkspaceRefresh?: () => Promise<void>;
}

function eventLabel(event: AssistantTaskEvent): string {
  if (event.content.length > 180) return '助手已更新结果，详情见下方会话内容';
  return event.content;
}

function compactEvents(events: AssistantTaskEvent[]): Array<AssistantTaskEvent & { repeatCount?: number }> {
  return events.reduce<Array<AssistantTaskEvent & { repeatCount?: number }>>((visible, event) => {
    const previous = visible.at(-1);
    if (previous && previous.taskId === event.taskId && previous.eventKind === event.eventKind && previous.content === event.content) {
      previous.repeatCount = (previous.repeatCount ?? 1) + 1;
      return visible;
    }
    visible.push({ ...event });
    return visible;
  }, []);
}

function TaskProcess({ task, events, liveTail, liveTask, resuming, onResume }: {
  task: AssistantTask; events: Array<AssistantTaskEvent & { repeatCount?: number }>; liveTail: AssistantTaskEvent | null;
  liveTask: boolean; resuming: boolean; onResume: () => void;
}) {
  return <details className="assistant-task-detail">
    <summary><Badge variant="secondary" className="assistant-task-status">{taskLabels[task.status]}</Badge><span>处理过程</span><ChevronDown size={15} aria-hidden="true" /></summary>
    {task.summary && <p>{task.summary}</p>}
    {events.length > 0 && <ol>{events.map(event => <li key={`${event.taskId}:${event.eventKey}`}><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time> <span>{event.eventKey === liveTail?.eventKey ? (liveTask ? '助手正在输出…' : '助手结果已转入会话') : eventLabel(event)}{event.repeatCount && event.repeatCount > 1 ? `（重复 ${event.repeatCount} 次）` : ''}</span></li>)}</ol>}
    {task.canResume && <Button type="button" size="sm" variant="outline" disabled={resuming} onClick={onResume}><RotateCcw size={14} />{resuming ? '正在恢复…' : '继续处理'}</Button>}
  </details>;
}

function mergePendingTurn(turns: AgentTurnDto[], pendingTurn: UserTurnDto | undefined): AgentTurnDto[] {
  if (!pendingTurn) return turns;
  const pendingAt = Date.parse(pendingTurn.createdAt);
  const hasDurableCopy = turns.some(turn => turn.kind === 'user'
    && turn.content === pendingTurn.content
    && (!Number.isFinite(pendingAt) || !Number.isFinite(Date.parse(turn.createdAt)) || Date.parse(turn.createdAt) >= pendingAt - 60_000));
  if (hasDurableCopy) return turns;
  return [...turns, pendingTurn].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

const LIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting_input', 'waiting_confirmation']);
const WORKSPACE_REFRESH_TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed']);

export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onArchive, onWorkspaceRefresh }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const [draft, setDraft] = useState(() => readDraft(teacherId, conversationId));
  const conversationBodyRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number; turnCount: number } | null>(null);
  const renderedContentRef = useRef('');
  const workspaceRefreshes = useRef(new Set<string>());
  const pendingConfirmationRequests = useRef(new Set<string>());
  const conversationScope = useRef(`${teacherId}:${conversationId}`);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [workspaceRefreshError, setWorkspaceRefreshError] = useState('');
  const [confirmationStatuses, setConfirmationStatuses] = useState<Record<string, ConfirmationStatus>>({});
  const [confirmationBusyId, setConfirmationBusyId] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState<Record<string, string>>({});
  useEffect(() => { setDraft(readDraft(teacherId, conversationId)); }, [teacherId, conversationId, messageState?.acceptedRequestId, messageState?.sending]);
  useEffect(() => {
    conversationScope.current = `${teacherId}:${conversationId}`;
    workspaceRefreshes.current.clear();
    pendingConfirmationRequests.current.clear();
    setWorkspaceRefreshError('');
    setConfirmationStatuses({});
    setConfirmationBusyId(null);
    setConfirmationError({});
  }, [teacherId, conversationId]);
  const visibleTurns = mergePendingTurn(session.turns, messageState?.pendingTurn);
  const visibleEvents = compactEvents(session.events);
  const latestAssistantEvent = [...session.events].reverse().find(event => event.eventKind === 'assistant_message' && event.content.trim());
  const liveTail = latestAssistantEvent && !visibleTurns.some(turn => turn.kind === 'assistant' && turn.content.trim() === latestAssistantEvent.content.trim())
    ? latestAssistantEvent : null;
  const liveTask = session.tasks.some(task => LIVE_TASK_STATUSES.has(task.status));
  const contentSignature = `${visibleTurns.map(turn => `${turn.id}:${'content' in turn ? turn.content.length : turn.kind}`).join('|')}|${session.events.length}|${session.tasks.map(task => `${task.id}:${task.status}`).join('|')}|${liveTail?.eventKey ?? ''}:${liveTail?.content.length ?? 0}`;
  const loadOlder = async () => {
    const container = conversationBodyRef.current;
    if (container) restoreScrollRef.current = { height: container.scrollHeight, top: container.scrollTop, turnCount: visibleTurns.length };
    await session.loadOlder();
  };
  useLayoutEffect(() => {
    const container = conversationBodyRef.current;
    if (!container) return;
    const previousSignature = renderedContentRef.current;
    renderedContentRef.current = contentSignature;
    const older = restoreScrollRef.current;
    if (older && visibleTurns.length > older.turnCount) {
      container.scrollTop = container.scrollHeight - older.height + older.top;
      restoreScrollRef.current = null;
      return;
    }
    if (!keepAtBottom.current) {
      if (previousSignature && previousSignature !== contentSignature) setShowJumpToBottom(true);
      return;
    }
    container.scrollTop = container.scrollHeight;
    setShowJumpToBottom(false);
  }, [contentSignature, visibleTurns.length, session.busy]);
  useLayoutEffect(() => {
    const older = restoreScrollRef.current;
    if (!older || visibleTurns.length <= older.turnCount) return;
    const container = conversationBodyRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight - older.height + older.top;
    restoreScrollRef.current = null;
  }, [visibleTurns.length]);
  const tasks = session.tasks.length ? session.tasks : messageState?.task ? [messageState.task] : [];
  const taskPlacement = new Map<string, AssistantTask>();
  for (const task of tasks) {
    const turn = [...visibleTurns].reverse().find(item => item.taskId === task.id);
    if (turn) taskPlacement.set(turn.id, task);
  }
  const historicalTasks = tasks.filter(task => ![...taskPlacement.values()].some(placed => placed.id === task.id));
  const refreshTargets = [
    ...tasks.filter(task => WORKSPACE_REFRESH_TERMINAL_STATUSES.has(task.status))
      .map(task => `task:${task.id}:${task.version ?? 'unknown'}:${task.status}`),
    ...session.events.filter(event => event.eventKind === 'assistant_message' && event.content.trim())
      .map(event => `event:${event.taskId}:${event.eventKey}`),
  ];
  useEffect(() => {
    if (!onWorkspaceRefresh) return;
    const pending = refreshTargets.filter(key => !workspaceRefreshes.current.has(key));
    if (pending.length === 0) return;
    pending.forEach(key => workspaceRefreshes.current.add(key));
    let cancelled = false;
    void (async () => {
      for (const _key of pending) {
        try {
          await onWorkspaceRefresh();
          if (!cancelled) setWorkspaceRefreshError('');
        } catch {
          if (!cancelled) setWorkspaceRefreshError('助手本轮已返回，资料刷新失败；请先刷新核对，不要重复登记。');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onWorkspaceRefresh, refreshTargets.join('|')]);
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
  const resizeComposer = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 54), 180)}px`;
  };
  const updateConfirmation = (actionId: string, status: ConfirmationStatus) => {
    setConfirmationStatuses(current => ({ ...current, [actionId]: status }));
    setConfirmationError(current => {
      const { [actionId]: _removed, ...remaining } = current;
      return remaining;
    });
  };
  const finishConfirmation = async (turn: ConfirmationTurnDto, operation: 'confirm' | 'cancel') => {
    const scope = `${teacherId}:${conversationId}`;
    if (pendingConfirmationRequests.current.has(turn.actionId) || conversationScope.current !== scope) return;
    if (turn.status !== 'pending' || !['scheduling.create', 'memos.create'].includes(turn.actionName)) return;
    if (operation === 'confirm' && (!turn.actionToken || Date.parse(turn.expiresAt) <= Date.now())) return;
    pendingConfirmationRequests.current.add(turn.actionId);
    setConfirmationBusyId(turn.actionId);
    setConfirmationError(current => {
      const { [turn.actionId]: _removed, ...remaining } = current;
      return remaining;
    });
    try {
      if (operation === 'confirm') {
        if (transport?.pendingActionApi) await transport.pendingActionApi.confirm({ teacherId, actionId: turn.actionId, actionToken: turn.actionToken! });
        else await confirmPendingAction(teacherId, turn.actionId, turn.actionToken!);
      } else if (transport?.pendingActionApi) await transport.pendingActionApi.cancel({ teacherId, actionId: turn.actionId });
      else await cancelPendingAction(teacherId, turn.actionId);
      if (conversationScope.current !== scope) return;
      updateConfirmation(turn.actionId, operation === 'confirm' ? 'consumed' : 'cancelled');
      void session.load();
      void session.reloadTasks();
      if (operation === 'confirm' && onWorkspaceRefresh) {
        try {
          await onWorkspaceRefresh();
          if (conversationScope.current === scope) setWorkspaceRefreshError('');
        } catch {
          if (conversationScope.current === scope) setWorkspaceRefreshError('助手本轮已返回，资料刷新失败；请先刷新核对，不要重复登记。');
        }
      }
    } catch {
      if (conversationScope.current === scope) setConfirmationError(current => ({
        ...current,
        [turn.actionId]: operation === 'confirm' ? '保存尚未确认，请重试。' : '取消尚未确认，请重试。',
      }));
    } finally {
      pendingConfirmationRequests.current.delete(turn.actionId);
      if (conversationScope.current === scope) setConfirmationBusyId(current => current === turn.actionId ? null : current);
    }
  };
  useLayoutEffect(() => { if (composerRef.current) resizeComposer(composerRef.current); }, [draft.text]);
  return <section className="assistant-conversation" aria-label="当前会话">
    <header className="assistant-conversation-heading">
      <div className="assistant-conversation-title">
        <div className="assistant-conversation-title-row"><span className="assistant-conversation-icon"><Sparkles size={15} /></span><h2>{session.conversation?.displayTitle ?? '读取会话'}</h2></div>
        <p className={`assistant-sync-status${session.syncError ? ' is-error' : ''}`} role="status" aria-live="polite">
          <span className="assistant-sync-dot" aria-hidden="true" />{syncStatus}
        </p>
      </div>
      {session.conversation?.status === 'active' && <Tooltip><TooltipTrigger asChild><Button type="button" size="sm" variant="ghost" className="assistant-archive" aria-label="归档会话" disabled={session.archiving || messageState?.sending || draft.awaitingReceipt} onClick={() => { void session.archive().then(saved => { if (saved) onArchive(); }); }}><Archive size={15} /><span>{session.archiving ? '归档中…' : '归档会话'}</span></Button></TooltipTrigger><TooltipContent>归档后仍可完整回看</TooltipContent></Tooltip>}
      {session.conversation?.status === 'archived' && <Badge variant="secondary">已归档 · 可完整回看</Badge>}
    </header>
    <div className="assistant-conversation-body" ref={conversationBodyRef} onScroll={event => {
      const container = event.currentTarget;
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 72;
      keepAtBottom.current = atBottom;
      setShowJumpToBottom(!atBottom && Boolean(renderedContentRef.current));
    }}>
      {session.busy && <p className="assistant-loading" role="status"><LoaderCircle size={16} />正在读取会话…</p>}
      {session.error && <Card className="assistant-inline-alert" role="alert"><CardContent><CircleAlert size={18} /><p>{session.error}</p><Button type="button" size="sm" variant="outline" disabled={session.busy} onClick={() => { void session.load(); }}>重新读取会话</Button></CardContent></Card>}
      {session.conversation && <>
        {session.previousCursor && <Button type="button" className="assistant-load-history" variant="ghost" size="sm" disabled={session.loadingHistory || session.busy} onClick={() => { void loadOlder(); }}>{session.loadingHistory ? '正在加载较早内容…' : '加载较早内容'}</Button>}
        <div className="assistant-turns" aria-label="会话内容">{visibleTurns.map(turn => {
          const task = taskPlacement.get(turn.id);
          const taskEvents = task ? visibleEvents.filter(event => event.taskId === task.id) : [];
          return <div key={turn.id} className="assistant-turn-with-process"><TurnContent turn={turn} demoMode={transport?.runtimeAvailability === 'test_only'}
            pendingLabel={turn.id === messageState?.pendingTurn?.id
              ? messageState?.sending ? '正在发送…' : messageState?.error?.includes('接收回执') ? '等待接收回执' : '已接收，等待会话记录'
              : undefined}
            confirmation={turn.kind === 'confirmation' ? {
              status: confirmationStatuses[turn.actionId], busy: confirmationBusyId === turn.actionId, error: confirmationError[turn.actionId],
              onConfirm: () => { void finishConfirmation(turn, 'confirm'); }, onCancel: () => { void finishConfirmation(turn, 'cancel'); },
            } : undefined} />
            {task && <TaskProcess task={task} events={taskEvents} liveTail={liveTail} liveTask={liveTask} resuming={session.resumingTaskId === task.id}
              onResume={() => { void session.resumeTask(task); }} />}
          </div>;
        })}</div>
        {liveTail && <Card className="assistant-live-tail" aria-live="polite"><CardContent>
          <header><div><span className="assistant-turn-role assistant-turn-role-assistant"><Sparkles size={14} />教学助手</span></div><span>{liveTask ? '正在输出…' : '最新结果待写入会话'}</span></header>
          <p>{liveTail.content}</p>
        </CardContent></Card>}
        {(historicalTasks.length > 0 || session.taskError) && <details className="assistant-historical-process">
          <summary>历史处理过程</summary>
          {historicalTasks.map(task => <TaskProcess key={task.id} task={task} events={visibleEvents.filter(event => event.taskId === task.id)} liveTail={liveTail} liveTask={liveTask}
            resuming={session.resumingTaskId === task.id} onResume={() => { void session.resumeTask(task); }} />)}
          {session.taskError && <p role="alert">{session.taskError}</p>}
          {transport?.getTasks && <Button type="button" size="sm" variant="outline" className="assistant-compact-button" onClick={() => { void session.reloadTasks(); void session.load(); }}><RotateCcw size={13} />刷新处理过程</Button>}
        </details>}
        {workspaceRefreshError && <Card className="assistant-workspace-refresh-error" role="alert"><CardContent><CircleAlert size={17} /><p>{workspaceRefreshError}</p><Button type="button" size="sm" variant="outline" className="assistant-compact-button" onClick={() => {
          if (!onWorkspaceRefresh) return;
          void onWorkspaceRefresh().then(() => setWorkspaceRefreshError('')).catch(() => {});
        }}>刷新资料</Button></CardContent></Card>}
        {!session.busy && visibleTurns.length === 0 && !liveTail && <div className="assistant-conversation-empty"><span className="assistant-empty-orb"><Sparkles size={20} /></span><div><h3>从一件具体的教学工作开始</h3><p>例如整理课堂记录、核对课时，或准备给家长的反馈。</p></div></div>}
        {showJumpToBottom && <Button type="button" className="assistant-scroll-bottom" size="sm" onClick={() => {
          const container = conversationBodyRef.current;
          if (!container) return;
          keepAtBottom.current = true;
          container.scrollTop = container.scrollHeight;
          setShowJumpToBottom(false);
        }}><ArrowDown size={15} />回到底部</Button>}
      </>}
    </div>
    {session.conversation?.status === 'active' && <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(conversationId, draft); }}>
      <div className="assistant-composer-label"><label htmlFor="assistant-message">交给教学助手的工作</label><span>Enter 发送 · Shift + Enter 换行</span></div>
      <Textarea ref={composerRef} id="assistant-message" rows={2} value={draft.text} disabled={messageState?.sending} readOnly={draft.awaitingReceipt}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (draft.text.trim() && !draft.awaitingReceipt && !messageState?.sending && !session.busy && transport) event.currentTarget.form?.requestSubmit();
        }}
        onChange={event => changeDraft(event.target.value)} onInput={event => resizeComposer(event.currentTarget)} placeholder="例如：整理今天的上课记录，核对课时，再写给家长的反馈" />
      <p className="assistant-hint">未发送的输入仅暂存在当前浏览器会话中，退出账号后清除。</p>
      {draft.awaitingReceipt && !messageState?.sending && <p role="status">这条消息的接收情况尚未确认。请先重试确认接收，再编辑或归档；重试不会重复提交同一项工作。</p>}
      {messageState?.error && <p role="alert">{messageState.error}</p>}
      {messageState?.sending && <p role="status">正在提交，等待接收回执…</p>}
      <Button type="submit" disabled={!transport || !draft.text.trim() || messageState?.sending || session.busy}>{messageState?.sending ? <><LoaderCircle className="assistant-spin" size={16} />提交中…</> : messageState?.error || draft.awaitingReceipt ? <><RotateCcw size={16} />重试发送</> : <><Send size={16} />发送</>}</Button>
    </form>}
  </section>;
}
