import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../app/teacher-context';
import { createCapture, confirmCapture } from '../api/captures';
import { createPayment } from '../api/payments';
import { updateStudentProfile } from '../api/students';
import {
  createFeedback,
  createFeedbackDraftTask,
  generateFeedbackDraft,
  getFeedbackDraftTask,
  getFeedbackSnapshot,
  listFeedbackDraftTasks,
  retryFeedbackDraftTask,
  updateFeedbackContent,
  updateFeedbackDraftTask,
} from '../api/feedback';
import { Dialog, Shell } from '../preview/Chrome';
import { Confirm, type PreviewActions, type Toast } from '../preview/PreviewApp';
import { TodayPage } from '../preview/Today';
import { StudentPages } from '../preview/Students';
import { Workflows } from '../preview/Workflows';
import { commitAction } from '../preview/action-result';
import { scheduleFromRule } from '../preview/recurrence';
import { loadWorkspace, schedulingCommand, workspaceCommand, type WorkspaceSnapshot } from './workspace-api';
import '../preview/preview.css';
import './connected.css';
import { PlatformAIStatus } from './PlatformAIStatus';
import { CaptureInbox } from './captures/CaptureInbox';
import { StudentRecordPanel } from './student-records/StudentRecordPanel';
import { StudentLedgerReadback } from './student-ledger/StudentLedgerReadback';
import { getTeachingRuntimeAvailability } from '../api/teaching-tasks';
import { AssistantWorkspace } from './assistant';
import { createTeachingTaskTransport } from './assistant/teaching-task-transport';

const routeParts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);

export function ConnectedWorkspace() {
  const auth = useAuth();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [route, setRoute] = useState(routeParts);
  const [dialog, setDialog] = useState<{ title: string; body: ReactNode } | null>(null);
  const [notice, setNotice] = useState<Toast>(null);
  const [teachingRuntimeAvailability, setTeachingRuntimeAvailability] = useState<'available' | 'unavailable' | 'test_only'>('unavailable');
  const assistantTransport = useMemo(
    () => createTeachingTaskTransport({ runtimeAvailability: teachingRuntimeAvailability }),
    [teachingRuntimeAvailability],
  );
  const alive = useRef(true); const keys = useRef(new Map<string, string>());
  const generation = useRef(0);
  const needsRefresh = useRef(false);
  const toast = (text: string, kind: 'warn' | 'ok' = 'ok') => { if (alive.current) setNotice({ text, kind }); };
  const close = () => { if (!busyRef.current) setDialog(null); };
  const open = (title: string, body: ReactNode) => setDialog({ title, body });
  async function reload() {
    const current = ++generation.current;
    try {
      const next = await loadWorkspace(auth.teacherId!);
      if (alive.current && current === generation.current) { setSnapshot(next); setError(''); needsRefresh.current = false; }
    } catch (failure) {
      if (alive.current && current === generation.current && failure instanceof Error && 'code' in failure && failure.code === 'WORKSPACE_IDENTITY_CHANGED') {
        setSnapshot(null); setDialog(null); void auth.refresh();
      }
      throw failure;
    }
  }
  useEffect(() => {
    alive.current = true;
    setTeachingRuntimeAvailability('unavailable');
    void reload().catch((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : '资料加载失败'); });
    void getTeachingRuntimeAvailability(auth.teacherId!).then((result) => {
      if (alive.current) setTeachingRuntimeAvailability(result.runtimeAvailability);
    }).catch(() => {
      // Keep the explicit unavailable state when capability discovery is down.
      if (alive.current) setTeachingRuntimeAvailability('unavailable');
    });
    return () => { alive.current = false; generation.current += 1; };
  }, [auth.teacherId]);
  useEffect(() => {
    const onRoute = () => { setRoute(routeParts()); if (!busyRef.current) setDialog(null); };
    addEventListener('hashchange', onRoute);
    if (!location.hash) location.hash = '#/today';
    return () => removeEventListener('hashchange', onRoute);
  }, []);
  const requestKey = (intent: string) => { if (!keys.current.has(intent)) keys.current.set(intent, crypto.randomUUID()); return keys.current.get(intent)!; };
  async function transaction(work: () => Promise<unknown>, refresh = true, allowStale = false) {
    if (busyRef.current) throw new Error('正在保存，请勿重复提交。');
    if (!allowStale && needsRefresh.current) throw new Error('请先点击“刷新资料”核对已保存的操作，再继续修改。');
    busyRef.current = true; setBusy(true); setNotice(null);
    try {
      const value = await work();
      if (refresh) {
        try { await reload(); }
        catch { needsRefresh.current = true; if (alive.current) setError('操作已保存，但最新资料加载失败。请刷新资料核对，不要重复登记。'); }
      }
      return value;
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function command(operation: string, body: Record<string, unknown>, scheduling = false) {
    const intent = JSON.stringify({ operation, body });
    await transaction(async () => {
      const payload = { ...body, clientRequestId: requestKey(intent) };
      const result = await (scheduling ? schedulingCommand({ ...payload, kind: operation }) : workspaceCommand(operation, payload));
      keys.current.delete(intent);
      return result;
    });
  }
  const retry = () => { if (!busyRef.current) void transaction(reload, false, true).catch((e: unknown) => setError(e instanceof Error ? e.message : '资料加载失败')); };
  if (!snapshot) return <main className="connected-load"><h1>教师工作室</h1>{error ? <><p role="alert">{error}</p><button className="button primary" onClick={retry} disabled={busy}>重新加载</button><button className="button secondary" onClick={() => void auth.logout()}>退出登录</button></> : <p role="status">正在加载你的工作资料…</p>}</main>;
  const actions: PreviewActions = {
    connected: true, data: snapshot.data, ui, setUi, open, close, toast,
    setData: () => { throw new Error('该操作尚未连接，请勿重复提交。'); },
    saveStudent: async (name, grade, id) => {
      if (id) await transaction(() => updateStudentProfile(auth.teacherId!, id, { expectedUpdatedAt: snapshotRef.current!.studentVersions[id], changes: { name, grade } }));
      else await command('students', { name, grade });
    },
    prepareRecord: async (studentId, text, onSaved) => {
      const intent = `record:${studentId}:${text}`;
      const result = await transaction(() => createCapture({ clientRequestId: requestKey(intent), sourceType: 'text', text }), false) as Awaited<ReturnType<typeof createCapture>>;
      open('核对并保存记录', <Confirm text={<>{snapshot.data.students.find((student) => student.id === studentId)?.name}<br /><span className="record-candidate">{result.capture.candidate.payload.text}</span></>} onCancel={close} onConfirm={() => commitAction(actions, async () => {
        await transaction(() => confirmCapture(result.capture.id, { clientRequestId: requestKey(`confirm:${result.capture.id}`), studentId })); keys.current.delete(intent);
      }, () => { close(); onSaved(); toast('记录已核对并保存'); })} label="确认归入档案" />);
    },
    saveMemo: (text) => command('memos', { text }),
    toggleMemo: (id, done) => command('memo-status', { id, done, expectedUpdatedAt: snapshotRef.current!.memoVersions[id] }),
    // 旧的预览入口仍保留在 PreviewActions 中；正式反馈页优先使用持久化任务。
    generateFeedbackDraft: (input) => generateFeedbackDraft(auth.teacherId!, input),
    ...(typeof createFeedbackDraftTask === 'function' && { createFeedbackDraftTask: (input: Parameters<typeof createFeedbackDraftTask>[1]) => createFeedbackDraftTask(auth.teacherId!, input) }),
    ...(typeof listFeedbackDraftTasks === 'function' && { listFeedbackDraftTasks: async () => (await listFeedbackDraftTasks(auth.teacherId!)).items }),
    ...(typeof getFeedbackDraftTask === 'function' && { getFeedbackDraftTask: (taskId: string) => getFeedbackDraftTask(auth.teacherId!, taskId) }),
    ...(typeof retryFeedbackDraftTask === 'function' && { retryFeedbackDraftTask: (taskId: string, input: Parameters<typeof retryFeedbackDraftTask>[2]) => retryFeedbackDraftTask(auth.teacherId!, taskId, input) }),
    ...(typeof updateFeedbackDraftTask === 'function' && { updateFeedbackDraftTask: (taskId: string, input: Parameters<typeof updateFeedbackDraftTask>[2]) => updateFeedbackDraftTask(auth.teacherId!, taskId, input) }),
    viewFeedbackSnapshot: (feedbackId) => getFeedbackSnapshot(auth.teacherId!, feedbackId),
    saveFeedback: async ({ id, studentId, title, content, lessonId, evidence, windowStart, windowEnd, generationTaskId }) => {
      if (id) {
        await transaction(() => updateFeedbackContent(auth.teacherId!, id, { expectedUpdatedAt: snapshotRef.current!.feedbackVersions[id], changes: { title, content } }));
        return;
      }
      const intent = `feedback:${JSON.stringify({ studentId, lessonId, title, content, evidence, windowStart, windowEnd, generationTaskId })}`;
      await transaction(async () => {
        const result = await createFeedback(auth.teacherId!, generationTaskId
          ? { studentId, title, content, generationTaskId, clientRequestId: requestKey(intent) }
          : { studentId, title, content, lessonId, evidence, windowStart, windowEnd, clientRequestId: requestKey(intent) });
        keys.current.delete(intent);
        return result;
      });
    },
    savePreferences: (changes) => command('preferences', { changes, expectedUpdatedAt: snapshotRef.current!.preferenceVersion }),
    addPayment: async (payment) => {
      // The current payment endpoint has no durable idempotency contract yet.
      // Do not send a decorative request key that the server cannot honor.
      await transaction(() => createPayment(auth.teacherId!, { studentId: payment.studentId, amount: payment.amount, lessonCount: payment.lessons, paidAt: `${payment.date}T12:00:00+08:00` }));
    },
    saveSchedule: (schedule) => {
      const current = snapshotRef.current!.data;
      const rule = current.recurrenceRules.find((item) => item.id === schedule.recurrenceRuleId);
      const before = current.schedules.find((item) => item.id === schedule.id) || (rule && schedule.recurrenceDay ? scheduleFromRule(rule, schedule.recurrenceDay) : undefined);
      return command(before?.status === '已取消' && schedule.status === '已排期' ? 'restore' : 'save-schedule', { schedule, before }, true);
    },
    complete: (id, planned) => command('complete', { before: planned || snapshotRef.current!.data.schedules.find((item) => item.id === id) }, true),
    cancelSchedule: (id, planned) => command('cancel', { before: planned || snapshotRef.current!.data.schedules.find((item) => item.id === id) }, true),
    editCompletedSchedule: (before, after) => command('edit-completed', { before, schedule: after }, true),
    saveRule: (rule) => command('save-rule', { rule }, true),
    replaceRuleFrom: (ruleId, from, rule) => command('replace-rule', { ruleId, from, rule, expectedUpdatedAt: snapshotRef.current!.data.recurrenceRules.find((item) => item.id === ruleId)?.updatedAt }, true),
    endRuleBefore: (ruleId, from) => command('end-rule', { ruleId, from, expectedUpdatedAt: snapshotRef.current!.data.recurrenceRules.find((item) => item.id === ruleId)?.updatedAt }, true),
    setRuleEnabled: (ruleId, enabled) => command('set-rule-enabled', { ruleId, enabled, expectedUpdatedAt: snapshotRef.current!.data.recurrenceRules.find((item) => item.id === ruleId)?.updatedAt }, true),
  };
  const page = route[0] || 'today';
  const normalized = page === 'schedule' ? 'schedules' : page === 'ai' ? 'agent' : page;
  const content = page === 'captures' ? <CaptureInbox key={auth.teacherId} teacherId={auth.teacherId!} onRecordsChanged={reload} students={snapshot.data.students} /> : page === 'students' ? <StudentPages actions={actions} studentId={route[1]} recordPanel={(studentId) => <StudentRecordPanel teacherId={auth.teacherId!} studentId={studentId} refreshToken={snapshot} onRecordsChanged={reload} />} ledgerPanel={(studentId) => <StudentLedgerReadback teacherId={auth.teacherId!} studentId={studentId} refreshToken={snapshot} />} /> : ['agent', 'schedules', 'finance', 'feedback', 'settings'].includes(normalized) ? <Workflows page={normalized} actions={actions} assistantContent={<AssistantWorkspace teacherId={auth.teacherId!} transport={assistantTransport} onWorkspaceRefresh={reload} />} modelSettings={<PlatformAIStatus availability={teachingRuntimeAvailability} />} /> : <TodayPage actions={actions} />;
  return <><div inert={busy || undefined} aria-busy={busy}>
    <Shell page={normalized} studioName={snapshot.data.studioName} displayName={auth.displayName || '教师'} accountActions={<><a className="button secondary small" href="#/captures">待核对材料</a><span>{auth.email}</span><button className="button secondary small" onClick={retry}>刷新资料</button><button className="button secondary small" onClick={() => void auth.logout()}>退出登录</button></>}>
      {(error || auth.error) && <div className="connected-error" role="alert">{error || auth.error}</div>}{content}
    </Shell>{dialog && <Dialog title={dialog.title} onClose={close} disabled={busy}>{dialog.body}</Dialog>}
  </div>{busy && <div className="connected-busy" role="status">正在处理，请稍候…</div>}{notice && <div className={`preview-toast ${notice.kind}`} role="status"><span>{notice.text}</span><button aria-label="关闭消息" onClick={() => setNotice(null)}>×</button></div>}</>;
}
