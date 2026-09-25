import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { AssistantComposer } from './AssistantComposer';
import { ConfirmationBatch } from './ConfirmationBatch';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import { taskLabels, type AssistantTransport } from './transport';
import type { AssistantTask, AssistantTaskEvent } from './transport';
import type { MessageState } from './useAssistantMessages';
import { cancelPendingAction, confirmPendingAction, getPendingAction, type AgentTurnDto, type ConfirmationStatus, type ConfirmationTurnDto, type UserTurnDto } from '../../api/conversations';
import { formatDateTime } from '../../shared/date-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Archive, ArrowDown, ChevronDown, CircleAlert, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>; onArchive: () => void;
  onWorkspaceRefresh?: () => Promise<void>;
  headerActions?: ReactNode;
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

function isRuntimeStateMarker(turn: AgentTurnDto): boolean {
  return turn.kind === 'tool' && turn.eventKind === 'task_state';
}

const LIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting_input', 'waiting_confirmation']);
const WORKSPACE_REFRESH_TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed']);
const BATCH_CONFIRMABLE_ACTIONS = new Set(['scheduling.create', 'memos.create']);

function groupConfirmationsByTask(turns: AgentTurnDto[]): ConfirmationTurnDto[][] {
  const groups: ConfirmationTurnDto[][] = [];
  for (let index = 0; index < turns.length;) {
    const first = turns[index];
    if (first?.kind !== 'confirmation' || !first.taskId || !BATCH_CONFIRMABLE_ACTIONS.has(first.actionName)) {
      index += 1;
      continue;
    }
    const group = [first];
    let nextIndex = index + 1;
    while (nextIndex < turns.length) {
      const next = turns[nextIndex];
      if (next?.kind !== 'confirmation' || next.taskId !== first.taskId || !BATCH_CONFIRMABLE_ACTIONS.has(next.actionName)) break;
      group.push(next);
      nextIndex += 1;
    }
    if (group.length > 1) groups.push(group);
    index = nextIndex;
  }
  return groups;
}

export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onArchive, onWorkspaceRefresh, headerActions }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const conversationBodyRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
  const restoreScrollRef = useRef<{ height: number; top: number; turnCount: number } | null>(null);
  const renderedContentRef = useRef('');
  const workspaceRefreshes = useRef(new Set<string>());
  const pendingConfirmationRequests = useRef(new Set<string>());
  const revisionRequestLock = useRef(false);
  const conversationScope = useRef(`${teacherId}:${conversationId}`);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [workspaceRefreshError, setWorkspaceRefreshError] = useState('');
  const [confirmationStatuses, setConfirmationStatuses] = useState<Record<string, ConfirmationStatus>>({});
  const [confirmationBusy, setConfirmationBusy] = useState<Record<string, boolean>>({});
  const [confirmationError, setConfirmationError] = useState<Record<string, string>>({});
  const [suggestedDraft, setSuggestedDraft] = useState<{ draft: AssistantDraft; basedOnRequestId: string } | null>(null);
  const [requestChangesErrors, setRequestChangesErrors] = useState<Record<string, string>>({});
  const [revisionBusyBatchId, setRevisionBusyBatchId] = useState<string | null>(null);
  const awaitingReceipt = readDraft(teacherId, conversationId).awaitingReceipt;
  useEffect(() => {
    conversationScope.current = `${teacherId}:${conversationId}`;
    workspaceRefreshes.current.clear();
    pendingConfirmationRequests.current.clear();
    revisionRequestLock.current = false;
    setWorkspaceRefreshError('');
    setConfirmationStatuses({});
    setConfirmationBusy({});
    setConfirmationError({});
    setSuggestedDraft(null);
    setRequestChangesErrors({});
    setRevisionBusyBatchId(null);
  }, [teacherId, conversationId]);
  const visibleTurns = mergePendingTurn(
    session.turns.filter(turn => !isRuntimeStateMarker(turn)),
    messageState?.pendingTurn,
  );
  const confirmationBatches = groupConfirmationsByTask(visibleTurns);
  const confirmationBatchStarts = new Map<string, ConfirmationTurnDto[]>();
  const confirmationBatchStartByHiddenTurn = new Map<string, string>();
  const batchedConfirmationTurnIds = new Set<string>();
  for (const group of confirmationBatches) {
    confirmationBatchStarts.set(group[0]!.id, group);
    group.forEach(turn => {
      batchedConfirmationTurnIds.add(turn.id);
      confirmationBatchStartByHiddenTurn.set(turn.id, group[0]!.id);
    });
  }
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
    if (turn) taskPlacement.set(confirmationBatchStartByHiddenTurn.get(turn.id) ?? turn.id, task);
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
    setConfirmationBusy(current => ({ ...current, [turn.actionId]: true }));
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
      if (conversationScope.current === scope) setConfirmationBusy(current => {
        const { [turn.actionId]: _removed, ...remaining } = current;
        return remaining;
      });
    }
  };
  const finishConfirmations = async (turns: ConfirmationTurnDto[]) => {
    const scope = `${teacherId}:${conversationId}`;
    if (conversationScope.current !== scope) return;
    const eligible = turns.filter(turn => {
      const status = confirmationStatuses[turn.actionId] ?? turn.status;
      return status === 'pending'
        && BATCH_CONFIRMABLE_ACTIONS.has(turn.actionName)
        && Boolean(turn.actionToken)
        && Date.parse(turn.expiresAt) > Date.now()
        && !pendingConfirmationRequests.current.has(turn.actionId);
    });
    if (eligible.length === 0) return;
    eligible.forEach(turn => pendingConfirmationRequests.current.add(turn.actionId));
    setConfirmationBusy(current => ({ ...current, ...Object.fromEntries(eligible.map(turn => [turn.actionId, true])) }));
    setConfirmationError(current => {
      const next = { ...current };
      eligible.forEach(turn => delete next[turn.actionId]);
      return next;
    });
    try {
      const results = await Promise.all(eligible.map(async turn => {
        try {
          if (transport?.pendingActionApi) await transport.pendingActionApi.confirm({ teacherId, actionId: turn.actionId, actionToken: turn.actionToken! });
          else await confirmPendingAction(teacherId, turn.actionId, turn.actionToken!);
          return { turn, status: 'consumed' as ConfirmationStatus, retryable: false };
        } catch {
          try {
            const current = transport?.pendingActionApi?.get
              ? await transport.pendingActionApi.get({ teacherId, actionId: turn.actionId })
              : transport?.pendingActionApi
                ? null
                : await getPendingAction(teacherId, turn.actionId);
            if (current) return { turn, status: current.pendingAction.status, retryable: current.pendingAction.status === 'pending' };
          } catch {
            // If authoritative readback also fails, retain the exact proposal for a safe retry.
          }
          return { turn, status: 'pending' as ConfirmationStatus, retryable: true };
        }
      }));
      if (conversationScope.current !== scope) return;
      const succeeded = results.filter(result => result.status === 'consumed');
      const failed = results.filter(result => result.retryable);
      setConfirmationStatuses(current => ({
        ...current,
        ...Object.fromEntries(results.map(result => [result.turn.actionId, result.status])),
      }));
      setConfirmationError(current => ({
        ...current,
        ...Object.fromEntries(failed.map(result => [result.turn.actionId, '保存尚未确认，请重试。'])),
      }));
      void Promise.all([session.load(), session.reloadTasks()]);
      if (succeeded.length > 0 && onWorkspaceRefresh) {
        try {
          await onWorkspaceRefresh();
          if (conversationScope.current === scope) setWorkspaceRefreshError('');
        } catch {
          if (conversationScope.current === scope) setWorkspaceRefreshError('助手本轮已返回，资料刷新失败；请先刷新核对，不要重复登记。');
        }
      }
    } finally {
      eligible.forEach(turn => pendingConfirmationRequests.current.delete(turn.actionId));
      if (conversationScope.current === scope) setConfirmationBusy(current => {
        const next = { ...current };
        eligible.forEach(turn => delete next[turn.actionId]);
        return next;
      });
    }
  };
  const requestConfirmationChanges = async (batchId: string, turns: ConfirmationTurnDto[]) => {
    const scope = `${teacherId}:${conversationId}`;
    if (conversationScope.current !== scope || messageState?.sending || revisionRequestLock.current) return;
    const draftBaseline = readDraft(teacherId, conversationId);
    if (draftBaseline.text.trim() || draftBaseline.awaitingReceipt) {
      setRequestChangesErrors(current => ({ ...current, [batchId]: '输入框已有未发送内容，请先发送或清空，再修改这批安排。' }));
      return;
    }
    writeDraft(teacherId, conversationId, draftBaseline);
    const pending = turns.filter(turn => (confirmationStatuses[turn.actionId] ?? turn.status) === 'pending'
      && !pendingConfirmationRequests.current.has(turn.actionId));
    if (pending.length === 0) return;
    revisionRequestLock.current = true;
    setRevisionBusyBatchId(batchId);
    setRequestChangesErrors(current => {
      const next = { ...current };
      delete next[batchId];
      return next;
    });
    setSuggestedDraft(null);
    pending.forEach(turn => pendingConfirmationRequests.current.add(turn.actionId));
    setConfirmationBusy(current => ({ ...current, ...Object.fromEntries(pending.map(turn => [turn.actionId, true])) }));
    setConfirmationError(current => {
      const next = { ...current };
      pending.forEach(turn => delete next[turn.actionId]);
      return next;
    });
    try {
      const results = await Promise.all(pending.map(async turn => {
        try {
          if (transport?.pendingActionApi) await transport.pendingActionApi.cancel({ teacherId, actionId: turn.actionId });
          else await cancelPendingAction(teacherId, turn.actionId);
          return { turn, status: 'cancelled' as ConfirmationStatus };
        } catch {
          try {
            const current = transport?.pendingActionApi?.get
              ? await transport.pendingActionApi.get({ teacherId, actionId: turn.actionId })
              : transport?.pendingActionApi
                ? null
                : await getPendingAction(teacherId, turn.actionId);
            if (current) return { turn, status: current.pendingAction.status };
          } catch {
            // Keep the old proposal visible until cancellation can be verified.
          }
          return { turn, status: 'pending' as ConfirmationStatus };
        }
      }));
      if (conversationScope.current !== scope) return;
      setConfirmationStatuses(current => ({
        ...current,
        ...Object.fromEntries(results.map(result => [result.turn.actionId, result.status])),
      }));
      const unresolved = results.filter(result => result.status === 'pending' || result.status === 'running');
      setConfirmationError(current => ({
        ...current,
        ...Object.fromEntries(unresolved.map(result => [result.turn.actionId, '旧候选尚未撤销，请重试修改。'])),
      }));
      void Promise.all([session.load(), session.reloadTasks()]);
      if (unresolved.length === 0) {
        const currentDraft = readDraft(teacherId, conversationId);
        if (currentDraft.requestId === draftBaseline.requestId && !currentDraft.awaitingReceipt) {
          setSuggestedDraft({
            basedOnRequestId: draftBaseline.requestId,
            draft: {
              requestId: crypto.randomUUID(),
              text: `请修改这批安排：\n${turns.map(turn => `- ${turn.afterSummary}`).join('\n')}\n\n我的修改是：`,
            },
          });
        } else {
          setRequestChangesErrors(current => ({ ...current, [batchId]: '旧候选已撤销；输入框内容已变化，请直接在当前输入中写明修改要求。' }));
        }
      }
    } finally {
      pending.forEach(turn => pendingConfirmationRequests.current.delete(turn.actionId));
      if (conversationScope.current === scope) setConfirmationBusy(current => {
        const next = { ...current };
        pending.forEach(turn => delete next[turn.actionId]);
        return next;
      });
      revisionRequestLock.current = false;
      if (conversationScope.current === scope) setRevisionBusyBatchId(null);
    }
  };
  return <section className="assistant-conversation" aria-label="当前会话">
    <header className="assistant-conversation-heading">
      <div className="assistant-conversation-title">
        <div className="assistant-conversation-title-row"><span className="assistant-conversation-icon"><Sparkles size={15} /></span><h2>{session.conversation?.displayTitle ?? '读取会话'}</h2></div>
        <p className={`assistant-sync-status${session.syncError ? ' is-error' : ''}`} role="status" aria-live="polite">
          <span className="assistant-sync-dot" aria-hidden="true" />{syncStatus}
        </p>
      </div>
      <div className="assistant-conversation-actions">{headerActions}{session.conversation?.status === 'active' && <Tooltip><TooltipTrigger asChild><Button type="button" size="sm" variant="ghost" className="assistant-archive" aria-label="归档会话" disabled={session.archiving || messageState?.sending || awaitingReceipt} onClick={() => { void session.archive().then(saved => { if (saved) onArchive(); }); }}><Archive size={15} /><span>{session.archiving ? '归档中…' : '归档会话'}</span></Button></TooltipTrigger><TooltipContent>归档后仍可完整回看</TooltipContent></Tooltip>}{session.conversation?.status === 'archived' && <Badge variant="secondary">已归档 · 可完整回看</Badge>}</div>
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
          if (batchedConfirmationTurnIds.has(turn.id) && !confirmationBatchStarts.has(turn.id)) return null;
          const task = taskPlacement.get(turn.id);
          const taskEvents = task ? visibleEvents.filter(event => event.taskId === task.id) : [];
          const confirmationBatch = confirmationBatchStarts.get(turn.id);
          const confirmationBatchId = confirmationBatch?.map(item => item.actionId).join('|');
          return <div key={turn.id} className="assistant-turn-with-process">{confirmationBatch
            ? <ConfirmationBatch turns={confirmationBatch} itemStates={Object.fromEntries(confirmationBatch.map(item => [item.actionId, {
              status: item.status === 'pending' ? confirmationStatuses[item.actionId] : item.status,
              busy: confirmationBusy[item.actionId], error: item.status === 'pending' ? confirmationError[item.actionId] : undefined,
            }]))} onConfirm={(_selectedActionIds, selectedTurns) => { void finishConfirmations(selectedTurns); }}
              onRequestChanges={items => { void requestConfirmationChanges(confirmationBatchId!, items); }} requestChangesError={requestChangesErrors[confirmationBatchId!]}
              requestChangesBusy={revisionBusyBatchId !== null} />
            : <TurnContent turn={turn} demoMode={transport?.runtimeAvailability === 'test_only'}
            pendingLabel={turn.id === messageState?.pendingTurn?.id
              ? messageState?.sending ? '正在发送…' : messageState?.error?.includes('接收回执') ? '等待接收回执' : '已接收，等待会话记录'
              : undefined}
            confirmation={turn.kind === 'confirmation' ? {
              status: confirmationStatuses[turn.actionId], busy: confirmationBusy[turn.actionId], error: confirmationError[turn.actionId],
              onConfirm: () => { void finishConfirmation(turn, 'confirm'); }, onCancel: () => { void finishConfirmation(turn, 'cancel'); },
            } : undefined} />}
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
    {session.conversation?.status === 'active' && <AssistantComposer teacherId={teacherId} draftScope={conversationId} messageState={messageState} available={Boolean(transport)} busy={session.busy} suggestedDraft={suggestedDraft} onSend={draft => send(conversationId, draft)} placeholder="继续交代要处理的教学工作…" />}
  </section>;
}
