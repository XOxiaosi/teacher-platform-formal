import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useConversation } from './useConversation';
import { TurnContent } from './TurnContent';
import { AssistantComposer } from './AssistantComposer';
import { readDraft, writeDraft, type AssistantDraft } from './drafts';
import type { AssistantTransport } from './transport';
import type { AssistantTask } from './transport';
import type { MessageState } from './useAssistantMessages';
import { cancelPendingAction, confirmPendingAction, getPendingAction, type AgentTurnDto, type ConfirmationStatus, type ConfirmationTurnDto, type UserTurnDto } from '../../api/conversations';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowDown, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';

interface Props {
  teacherId: string; conversationId: string; transport?: AssistantTransport; messageState?: MessageState;
  send: (conversationId: string, draft: AssistantDraft) => Promise<void>;
  onWorkspaceRefresh?: () => Promise<void>;
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

function isVisibleBusinessOutcome(turn: AgentTurnDto): boolean {
  return turn.kind === 'tool'
    && turn.status === 'success'
    && ['create', 'update', 'delete'].includes(turn.sideEffect)
    && Boolean(turn.resultSummary?.trim() || turn.references.length > 0);
}

const WORKSPACE_REFRESH_TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed']);

export function ConversationPanel({ teacherId, conversationId, transport, messageState, send, onWorkspaceRefresh }: Props) {
  const session = useConversation(teacherId, conversationId, transport, messageState?.acceptedRequestId);
  const conversationBodyRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
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
  const [confirmationReceipts, setConfirmationReceipts] = useState<Record<string, string>>({});
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
    session.turns.filter(turn => !isRuntimeStateMarker(turn) && (turn.kind !== 'tool' || isVisibleBusinessOutcome(turn))),
    messageState?.pendingTurn,
  );
  const latestAssistantEvent = [...session.events].reverse().find(event => event.eventKind === 'assistant_message' && event.content.trim());
  const liveTail = latestAssistantEvent && !visibleTurns.some(turn => turn.kind === 'assistant' && turn.content.trim() === latestAssistantEvent.content.trim())
    ? latestAssistantEvent : null;
  const contentSignature = `${visibleTurns.map(turn => `${turn.id}:${'content' in turn ? turn.content.length : turn.kind}`).join('|')}|${liveTail?.eventKey ?? ''}:${liveTail?.content.length ?? 0}`;
  useLayoutEffect(() => {
    const container = conversationBodyRef.current;
    if (!container) return;
    const previousSignature = renderedContentRef.current;
    renderedContentRef.current = contentSignature;
    if (!keepAtBottom.current) {
      if (previousSignature && previousSignature !== contentSignature) setShowJumpToBottom(true);
      return;
    }
    container.scrollTop = container.scrollHeight;
    setShowJumpToBottom(false);
  }, [contentSignature, visibleTurns.length, session.busy]);
  const tasks = session.tasks.length ? session.tasks : messageState?.task ? [messageState.task] : [];
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
          if (!cancelled) setWorkspaceRefreshError('教学资料更新未能同步，请刷新页面核对后再操作。');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onWorkspaceRefresh, refreshTargets.join('|')]);
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
        const result = transport?.pendingActionApi
          ? await transport.pendingActionApi.confirm({ teacherId, actionId: turn.actionId, actionToken: turn.actionToken! })
          : await confirmPendingAction(teacherId, turn.actionId, turn.actionToken!);
        const receipt = result && 'result' in result ? result.result?.summary : undefined;
        if (receipt && conversationScope.current === scope) setConfirmationReceipts(current => ({ ...current, [turn.actionId]: receipt }));
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
          if (conversationScope.current === scope) setWorkspaceRefreshError('教学资料更新未能同步，请刷新页面核对后再操作。');
        }
      }
    } catch {
      if (conversationScope.current === scope) setConfirmationError(current => ({
        ...current,
        [turn.actionId]: operation === 'confirm' ? '暂时无法确认保存，请重试。' : '暂时无法取消变更，请重试。',
      }));
    } finally {
      pendingConfirmationRequests.current.delete(turn.actionId);
      if (conversationScope.current === scope) setConfirmationBusy(current => {
        const { [turn.actionId]: _removed, ...remaining } = current;
        return remaining;
      });
    }
  };
  const requestConfirmationChanges = async (batchId: string, turns: ConfirmationTurnDto[]) => {
    const scope = `${teacherId}:${conversationId}`;
    if (conversationScope.current !== scope || messageState?.sending || revisionRequestLock.current) return;
    const draftBaseline = readDraft(teacherId, conversationId);
    if (draftBaseline.text.trim() || draftBaseline.awaitingReceipt) {
      setRequestChangesErrors(current => ({ ...current, [batchId]: '输入框已有未发送内容，请先发送或清空后再修改。' }));
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
        ...Object.fromEntries(unresolved.map(result => [result.turn.actionId, '这项待确认变更尚未撤销，请重试修改。'])),
      }));
      void Promise.all([session.load(), session.reloadTasks()]);
      if (unresolved.length === 0) {
        const currentDraft = readDraft(teacherId, conversationId);
        if (currentDraft.requestId === draftBaseline.requestId && !currentDraft.awaitingReceipt) {
          setSuggestedDraft({
            basedOnRequestId: draftBaseline.requestId,
            draft: {
              requestId: crypto.randomUUID(),
              text: `${turns.length === 1 ? '请修改这项安排：' : '请修改这些安排：'}\n${turns.map(turn => `- ${turn.afterSummary}`).join('\n')}\n\n我的修改是：`,
            },
          });
        } else {
          setRequestChangesErrors(current => ({ ...current, [batchId]: '待确认变更已撤销；输入框内容已变化，请在当前输入中写明修改要求。' }));
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
  return <section className="assistant-conversation" aria-label="教学助手对话">
    <div className="assistant-conversation-body" ref={conversationBodyRef} onScroll={event => {
      const container = event.currentTarget;
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 72;
      keepAtBottom.current = atBottom;
      setShowJumpToBottom(!atBottom && Boolean(renderedContentRef.current));
    }}>
      {session.busy && <p className="assistant-loading" role="status"><LoaderCircle size={16} />正在读取会话…</p>}
      {session.error && <Card className="assistant-inline-alert" role="alert"><CardContent><CircleAlert size={18} /><p>{session.error}</p><Button type="button" size="sm" variant="outline" disabled={session.busy} onClick={() => { void session.load(); }}>重新读取会话</Button></CardContent></Card>}
      {session.conversation && <>
        <div className="assistant-turns" aria-label="会话内容">{visibleTurns.map(turn =>
          <div key={turn.id} className="assistant-turn-with-process"><TurnContent turn={turn} demoMode={transport?.runtimeAvailability === 'test_only'}
            confirmation={turn.kind === 'confirmation' ? {
              status: confirmationStatuses[turn.actionId], busy: confirmationBusy[turn.actionId], modifying: revisionBusyBatchId !== null,
              error: confirmationError[turn.actionId] ?? requestChangesErrors[turn.actionId], receipt: confirmationReceipts[turn.actionId],
              onConfirm: () => { void finishConfirmation(turn, 'confirm'); }, onModify: () => { void requestConfirmationChanges(turn.actionId, [turn]); },
            } : undefined} /></div>,
        )}</div>
        {liveTail && <div className="assistant-turn assistant-turn-assistant assistant-live-tail" aria-live="polite"><p>{liveTail.content}</p></div>}
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
