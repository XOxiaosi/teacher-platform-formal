import { useEffect, useRef, useState } from 'react';
import { archiveConversation, getConversation, listConversationTurns, type AgentTurnDto, type ConversationDetailDto } from '../../api/conversations';
import type { AssistantTask, AssistantTaskEvent, AssistantTransport } from './transport';

export const CONVERSATION_POLL_INTERVAL_MS = 3000;

const LIVE_TASK_STATUSES = new Set<AssistantTask['status']>([
  'queued', 'running', 'waiting_input', 'waiting_confirmation',
]);

function isLiveTask(task: AssistantTask): boolean {
  return LIVE_TASK_STATUSES.has(task.status);
}

function mergeTurns(previous: AgentTurnDto[], incoming: AgentTurnDto[]): AgentTurnDto[] {
  const byId = new Map(previous.map(turn => [turn.id, turn]));
  incoming.forEach(turn => byId.set(turn.id, turn));
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function useConversation(teacherId: string, conversationId: string, transport: AssistantTransport | undefined, receipt?: string) {
  const conversationApi = transport?.conversationApi;
  const [conversation, setConversation] = useState<ConversationDetailDto | null>(null);
  const [turns, setTurns] = useState<AgentTurnDto[]>([]);
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [events, setEvents] = useState<AssistantTaskEvent[]>([]);
  const [previousCursor, setPreviousCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState('');
  const [taskError, setTaskError] = useState('');
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const alive = useRef(true);
  const version = useRef(0);
  const historyLock = useRef(false);
  const archiveLock = useRef(false);
  const conversationRefreshLock = useRef(false);
  const taskRefreshLock = useRef(false);
  const eventCursorRef = useRef<Record<string, number>>({});
  const tasksRef = useRef<AssistantTask[]>([]);
  const taskRefreshPendingRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current += 1; }; }, []);
  async function reloadTaskEvents(taskItems: AssistantTask[]) {
    if (!transport?.getTaskEvents || taskItems.length === 0) return;
    const eventResults = await Promise.all(taskItems.map(task => transport.getTaskEvents!({
      teacherId, conversationId, taskId: task.id, afterSeq: eventCursorRef.current[task.id],
    })));
    if (!alive.current) return;
    setEvents(previous => {
      const seen = new Set(previous.map(event => `${event.taskId}:${event.eventKey}`));
      const incoming = eventResults.flatMap((result, index) => result.items.map(event => ({
        ...event,
        taskId: event.taskId || taskItems[index]!.id,
      }))).filter(event => {
        const key = `${event.taskId}:${event.eventKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...previous, ...incoming]
        .sort((a, b) => a.seq - b.seq);
    });
    const nextCursor = { ...eventCursorRef.current };
    taskItems.forEach((task, index) => {
      const eventResult = eventResults[index];
      const maxSeq = eventResult.items.reduce((max, event) => Math.max(max, event.seq), 0);
      const cursor = eventResult.nextSeq ?? (maxSeq > 0 ? maxSeq : undefined);
      if (cursor !== undefined) nextCursor[task.id] = cursor;
    });
    eventCursorRef.current = nextCursor;
  }
  async function reloadTasks(options: { activeOnly?: boolean } = {}): Promise<boolean> {
    if (!transport?.getTasks || taskRefreshLock.current) return false;
    taskRefreshLock.current = true;
    setTaskError('');
    try {
      const result = await transport.getTasks({ teacherId, conversationId });
      if (alive.current) {
        tasksRef.current = result;
        setTasks(result);
        await reloadTaskEvents(options.activeOnly ? result.filter(isLiveTask) : result);
      }
      return true;
    } catch { if (alive.current) setTaskError('任务进度暂时无法读取，请重试。'); return false; }
    finally { taskRefreshLock.current = false; }
  }
  async function load() {
    const request = ++version.current;
    setBusy(true); setError('');
    try {
      const [detail, history] = await Promise.all([
        (conversationApi?.detail ?? getConversation)(teacherId, conversationId),
        (conversationApi?.turns ?? listConversationTurns)(teacherId, conversationId),
      ]);
      if (!alive.current || version.current !== request) return;
      setConversation(detail.conversation); setTurns(history.items); setPreviousCursor(history.previousCursor);
      setSyncError(''); setLastSyncedAt(new Date().toISOString());
    } catch { if (alive.current && version.current === request) setError('会话暂时无法读取，请重试。'); }
    finally {
      if (alive.current && version.current === request) setBusy(false);
    }
  }
  async function refresh() {
    if (conversationRefreshLock.current || !alive.current) return;
    const request = version.current;
    conversationRefreshLock.current = true;
    if (alive.current) { setSyncing(true); setSyncError(''); }
    try {
      const history = await (conversationApi?.turns ?? listConversationTurns)(teacherId, conversationId);
      if (!alive.current || version.current !== request) return;
      setTurns(previous => mergeTurns(previous, history.items));
      const forceTaskRefresh = taskRefreshPendingRef.current;
      if (forceTaskRefresh || tasksRef.current.some(isLiveTask)) {
        const refreshed = await reloadTasks({ activeOnly: !forceTaskRefresh });
        if (refreshed && forceTaskRefresh) taskRefreshPendingRef.current = false;
      }
      if (alive.current && version.current === request) setLastSyncedAt(new Date().toISOString());
    } catch {
      if (alive.current && version.current === request) setSyncError('实时更新暂时中断，将自动重试。');
    } finally {
      conversationRefreshLock.current = false;
      if (alive.current && version.current === request) setSyncing(false);
    }
  }
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, CONVERSATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // ConversationPanel is keyed by conversation id; receipt restarts the cycle
    // so a newly accepted message is read immediately and then kept in sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, conversationId, receipt]);
  useEffect(() => {
    const hasNewReceipt = receipt !== undefined;
    if (hasNewReceipt) taskRefreshPendingRef.current = true;
    void load();
    void reloadTasks().then(refreshed => {
      if (hasNewReceipt && refreshed) taskRefreshPendingRef.current = false;
    });
  }, [receipt]);
  async function loadOlder() {
    if (!previousCursor || historyLock.current || busy) return;
    historyLock.current = true; setLoadingHistory(true); setError('');
    const request = version.current;
    try {
      const history = await (conversationApi?.turns ?? listConversationTurns)(teacherId, conversationId, { before: previousCursor });
      if (!alive.current || version.current !== request) return;
      setTurns(previous => [...history.items.filter(item => !previous.some(old => old.id === item.id)), ...previous]);
      setPreviousCursor(history.previousCursor);
    } catch { if (alive.current && version.current === request) setError('较早内容暂时无法读取，请重试加载较早内容。'); }
    finally { historyLock.current = false; if (alive.current) setLoadingHistory(false); }
  }
  async function archive(): Promise<boolean> {
    if (archiveLock.current) return false;
    archiveLock.current = true; setArchiving(true); setError('');
    try {
      const result = await (conversationApi?.archive ?? archiveConversation)(teacherId, conversationId);
      if (!alive.current) return false;
      setConversation(result.conversation); return true;
    } catch { if (alive.current) setError('会话尚未归档，请重试。'); return false; }
    finally { archiveLock.current = false; if (alive.current) setArchiving(false); }
  }
  async function resumeTask(task: AssistantTask): Promise<boolean> {
    if (!transport?.resumeTask || !task.canResume || resumingTaskId) return false;
    setResumingTaskId(task.id); setTaskError('');
    try {
      const resumed = await transport.resumeTask({ teacherId, conversationId, taskId: task.id });
      if (!alive.current) return false;
      tasksRef.current = [resumed, ...tasksRef.current.filter(item => item.id !== resumed.id)];
      setTasks(previous => [resumed, ...previous.filter(item => item.id !== resumed.id)]);
      await reloadTaskEvents([resumed]);
      return true;
    } catch { if (alive.current) setTaskError('任务尚未恢复，请稍后重试。'); return false; }
    finally { if (alive.current) setResumingTaskId(null); }
  }
  return { conversation, turns, tasks, events, previousCursor, busy, loadingHistory, archiving, error, taskError, resumingTaskId,
    syncing, syncError, lastSyncedAt, load, refresh, reloadTasks, loadOlder, archive, resumeTask };
}
