import { ReactNode, useEffect, useState } from 'react';
import { createDemoData, DemoData, Payment, RecurrenceRule, Schedule } from './data';
import { dateAdd, recurrenceConflict, scheduleConflict as scheduleConflictInRange, schedulesInRange } from './recurrence';
import { cancelPlannedSchedule, completePlannedSchedule, editCompletedSchedule as editCompletedScheduleMutation, endRuleBefore as endRuleBeforeMutation, replaceRuleFrom as replaceRuleFromMutation } from './schedule-mutations';
import { Dialog, Shell } from './Chrome';
import { TodayPage } from './Today';
import { StudentPages } from './Students';
import { Workflows } from './Workflows';
import type {
  CreateFeedbackDraftTaskBody,
  FeedbackDraftTask,
  FeedbackDraftTaskReceipt,
  RetryFeedbackDraftTaskBody,
  UpdateFeedbackDraftTaskBody,
} from '../contracts/feedback-draft';

export type Toast = { text: string; kind?: 'warn' | 'ok' } | null;
export type FeedbackEvidenceItem = {
  id: string;
  sourceVersion?: string;
  originalDeleted?: boolean;
  type: 'assessment' | 'record' | 'lesson';
  occurredAt: string;
  category: string | null;
  summary: string | null;
  examName: string | null;
  subject: string | null;
  score: number | null;
  fullScore: number | null;
  previousScore: number | null;
};
export type GenerateFeedbackDraftRequest = {
  studentId: string;
  lessonIds?: string[];
  recordIds?: string[];
  tone?: 'formal' | 'warm' | 'concise';
  classSize?: '1v1' | 'small' | 'large';
  parentType?: 'normal' | 'scores' | 'sensitive';
  focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
};
export type GenerateFeedbackDraftResult = GenerateFeedbackDraftRequest & {
  lessonIds: string[];
  title: string;
  content: string;
  source: 'ai';
  rationale: string;
  evidence?: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
};
export type FeedbackSaveInput = {
  studentId: string;
  title: string;
  content: string;
  id?: string;
  lessonId?: string;
  evidence?: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
  generationTaskId?: string;
};
export type FeedbackSnapshot = {
  feedbackId: string;
  windowStart: string | null;
  windowEnd: string | null;
  assembledAt: string;
  evidence: FeedbackEvidenceItem[];
};
export type PreviewActions = {
  connected?: boolean;
  saveStudent?: (name: string, grade: string, id?: string) => Promise<void>;
  prepareRecord?: (studentId: string, text: string, onSaved: () => void) => Promise<void>;
  saveMemo?: (text: string) => Promise<void>;
  toggleMemo?: (id: string, done: boolean) => Promise<void>;
  generateFeedbackDraft?: (input: GenerateFeedbackDraftRequest) => Promise<GenerateFeedbackDraftResult>;
  createFeedbackDraftTask?: (input: CreateFeedbackDraftTaskBody) => Promise<FeedbackDraftTaskReceipt>;
  listFeedbackDraftTasks?: () => Promise<FeedbackDraftTask[]>;
  getFeedbackDraftTask?: (taskId: string) => Promise<FeedbackDraftTask>;
  retryFeedbackDraftTask?: (taskId: string, input: RetryFeedbackDraftTaskBody) => Promise<FeedbackDraftTaskReceipt>;
  updateFeedbackDraftTask?: (taskId: string, input: UpdateFeedbackDraftTaskBody) => Promise<FeedbackDraftTask>;
  saveFeedback?: (feedback: FeedbackSaveInput) => Promise<void>;
  viewFeedbackSnapshot?: (feedbackId: string) => Promise<FeedbackSnapshot>;
  savePreferences?: (changes: { studioName?: string; modelChoice?: string; wechatChannel?: string }) => Promise<void>;
  ui?: Record<string, unknown>; setUi?: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  data: DemoData; setData: React.Dispatch<React.SetStateAction<DemoData>>; open: (title: string, body: ReactNode) => void; toast: (text: string, kind?: 'warn' | 'ok') => void;
  close: () => void; complete: (id: string, planned?: Schedule) => void | Promise<void>; saveSchedule: (schedule: Schedule) => void | Promise<void>; cancelSchedule: (id: string, planned?: Schedule) => void | Promise<void>;
  editCompletedSchedule?: (before: Schedule, after: Schedule) => void | Promise<void>;
  saveRule: (rule: RecurrenceRule) => void | Promise<void>; replaceRuleFrom: (ruleId: string, from: string, rule: RecurrenceRule) => void | Promise<void>; endRuleBefore?: (ruleId: string, from: string) => void | Promise<void>; setRuleEnabled: (id: string, enabled: boolean) => void | Promise<void>;
  addPayment: (payment: Payment) => void | Promise<void>;
  pendingPayment?: Payment;
};

function getRoute() { return location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean); }

export function PreviewApp({ assistantContent }: { assistantContent?: ReactNode } = {}) {
  const [data, setData] = useState<DemoData>(createDemoData);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [route, setRoute] = useState(getRoute);
  const [dialog, setDialog] = useState<{ title: string; body: ReactNode } | null>(null);
  const [toastState, setToastState] = useState<Toast>(null);
  useEffect(() => { const listener = () => { setRoute(getRoute()); setDialog(null); }; addEventListener('hashchange', listener); if (!location.hash) location.hash = '#/today'; return () => removeEventListener('hashchange', listener); }, []);
  const toast = (text: string, kind: 'warn' | 'ok' = 'ok') => { setToastState({ text, kind }); setTimeout(() => setToastState(null), 3200); };
  const open = (title: string, body: ReactNode) => setDialog({ title, body });
  const close = () => setDialog(null);
  const complete = (id: string, planned?: Schedule) => setData((old) => { const target = old.schedules.find((item) => item.id === id) || planned; return target ? completePlannedSchedule(old, target) : old; });
  const saveSchedule = (schedule: Schedule) => setData((old) => ({ ...old, schedules: old.schedules.some((item) => item.id === schedule.id) ? old.schedules.map((item) => item.id === schedule.id ? schedule : item) : [...old.schedules, schedule] }));
  const editCompletedSchedule = (before: Schedule, after: Schedule) => setData((old) => editCompletedScheduleMutation(old, before, after, { id: `sr-${Date.now()}`, scheduleId: before.id, changedAt: new Date().toISOString(), before, after }));
  const cancelSchedule = (id: string, planned?: Schedule) => setData((old) => { const target = old.schedules.find((item) => item.id === id) || planned; return target ? cancelPlannedSchedule(old, target) : old; });
  const saveRule = (rule: RecurrenceRule) => setData((old) => ({ ...old, recurrenceRules: old.recurrenceRules.some((item) => item.id === rule.id) ? old.recurrenceRules.map((item) => item.id === rule.id ? rule : item) : [...old.recurrenceRules, rule] }));
  const replaceRuleFrom = (ruleId: string, from: string, rule: RecurrenceRule) => setData((old) => replaceRuleFromMutation(old, ruleId, from, rule));
  const endRuleBefore = (ruleId: string, from: string) => setData((old) => endRuleBeforeMutation(old, ruleId, from));
  const setRuleEnabled = (id: string, enabled: boolean) => {
    const rule = data.recurrenceRules.find((item) => item.id === id);
    if (enabled && rule && recurrenceConflict(data, { ...rule, enabled: true }, id)) { toast('启用会与未来排期冲突，规则仍保持暂停。', 'warn'); return; }
    setData((old) => ({ ...old, recurrenceRules: old.recurrenceRules.map((item) => item.id === id ? { ...item, enabled } : item) }));
  };
  const addPayment = (payment: Payment) => setData((old) => ({ ...old, payments: [payment, ...old.payments], students: old.students.map((student) => student.id === payment.studentId ? { ...student, balance: student.balance + payment.lessons } : student) }));
  const actions: PreviewActions = { data, setData, ui, setUi, open, toast, close, complete, saveSchedule, cancelSchedule, editCompletedSchedule, saveRule, replaceRuleFrom, endRuleBefore, setRuleEnabled, addPayment };
  const page = route[0] || 'today';
  let content: ReactNode = <TodayPage actions={actions} />;
  if (page === 'students') content = <StudentPages actions={actions} studentId={route[1]} />;
  const normalizedPage = page === 'ai' ? 'agent' : page === 'schedule' ? 'schedules' : page;
  if (['agent', 'schedules', 'finance', 'feedback', 'settings'].includes(normalizedPage)) content = <Workflows page={normalizedPage} actions={actions} />;
  if (normalizedPage === 'agent' && assistantContent) content = assistantContent;
  return <><Shell page={normalizedPage} studioName={data.studioName}>{content}</Shell>{dialog && <Dialog title={dialog.title} onClose={close}>{dialog.body}</Dialog>}{toastState && <div className={`preview-toast ${toastState.kind || ''}`} role="status">{toastState.text}</div>}</>;
}

export function Confirm({ text, onCancel, onConfirm, label = '确认', cancelLabel = '取消' }: { text: ReactNode; onCancel: () => void; onConfirm: () => void; label?: string; cancelLabel?: string }) {
  return <><p className="dialog-copy">{text}</p><div className="dialog-actions"><button className="button secondary" onClick={onCancel}>{cancelLabel}</button><button className="button primary" onClick={onConfirm}>{label}</button></div></>;
}

export function studentName(data: DemoData, id: string) { return data.students.find((item) => item.id === id)?.name || '未找到学生'; }
export function schedulesForDay(data: DemoData, day: string) { return schedulesInRange(data, day, day); }
/** Compatibility export while the schedule page moves to recurrence.ts. */
export function scheduleConflict(items: Schedule[], candidate: Schedule) { return scheduleConflictInRange(items, candidate); }
