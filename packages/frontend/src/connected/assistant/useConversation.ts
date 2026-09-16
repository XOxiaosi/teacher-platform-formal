import { useEffect, useRef, useState } from 'react';
import { archiveConversation, getConversation, listConversationTurns, type AgentTurnDto, type ConversationDetailDto } from '../../api/conversations';
import type { AssistantTask, AssistantTaskEvent, AssistantTransport } from './transport';

export function useConversation(teacherId: string, conversationId: string, transport: AssistantTransport | undefined, receipt?: string) {
  const [conversation, setConversation] = useState<ConversationDetailDto | null>(null);
  const [turns, setTurns] = useState<AgentTurnDto[]>([]);
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [events, setEvents] = useState<AssistantTaskEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<Record<string, number>>({});
  const [previousCursor, setPreviousCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState('');
  const [taskError, setTaskError] = useState('');
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const alive = useRef(true);
  const version = useRef(0);
  const historyLock = useRef(false);
  const archiveLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current += 1; }; }, []);
  async function reloadTaskEvents(taskItems: AssistantTask[]) {
    if (!transport?.getTaskEvents || taskItems.length === 0) return;
    const eventResults = await Promise.all(taskItems.map(task => transport.getTaskEvents!({
      teacherId, conversationId, taskId: task.id, afterSeq: eventCursor[task.id],
    })));
    if (!alive.current) return;
    setEvents(previous => {
      const seen = new Set(previous.map(event => event.eventKey));
      return [...previous, ...eventResults.flatMap(result => result.items).filter(event => !seen.has(event.eventKey))]
        .sort((a, b) => a.seq - b.seq);
    });
    setEventCursor(previous => {
      const next = { ...previous };
      taskItems.forEach((task, index) => {
        const eventResult = eventResults[index];
        const maxSeq = eventResult.items.reduce((max, event) => Math.max(max, event.seq), 0);
        const cursor = eventResult.nextSeq ?? (maxSeq > 0 ? maxSeq : undefined);
        if (cursor !== undefined) next[task.id] = cursor;
      });
      return next;
    });
  }
  async function reloadTasks() {
    if (!transport?.getTasks) return;
    setTaskError('');
    try {
      const result = await transport.getTasks({ teacherId, conversationId });
      if (alive.current) {
        setTasks(result);
        await reloadTaskEvents(result);
      }
    } catch { if (alive.current) setTaskError('任务进度暂时无法读取，请重试。'); }
  }
  async function load() {
    const request = ++version.current;
    setBusy(true); setError('');
    try {
      const [detail, history] = await Promise.all([getConversation(teacherId, conversationId), listConversationTurns(teacherId, conversationId)]);
      if (!alive.current || version.current !== request) return;
      setConversation(detail.conversation); setTurns(history.items); setPreviousCursor(history.previousCursor);
    } catch { if (alive.current && version.current === request) setError('会话暂时无法读取，请重试。'); }
    finally { if (alive.current && version.current === request) setBusy(false); }
  }
  useEffect(() => { void load(); void reloadTasks(); }, [receipt]);
  async function loadOlder() {
    if (!previousCursor || historyLock.current || busy) return;
    historyLock.current = true; setLoadingHistory(true); setError('');
    const request = version.current;
    try {
      const history = await listConversationTurns(teacherId, conversationId, { before: previousCursor });
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
      const result = await archiveConversation(teacherId, conversationId);
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
      setTasks(previous => [resumed, ...previous.filter(item => item.id !== resumed.id)]);
      await reloadTaskEvents([resumed]);
      return true;
    } catch { if (alive.current) setTaskError('任务尚未恢复，请稍后重试。'); return false; }
    finally { if (alive.current) setResumingTaskId(null); }
  }
  return { conversation, turns, tasks, events, previousCursor, busy, loadingHistory, archiving, error, taskError, resumingTaskId, load, reloadTasks, loadOlder, archive, resumeTask };
}
