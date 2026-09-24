import { FormEvent, useEffect, useRef, useState } from 'react';
import { PreviewActions, studentName, type FeedbackEvidenceItem, type FeedbackSaveInput, type FeedbackSnapshot } from './PreviewApp';
import { Feedback, today } from './data';
import { usePreviewState } from './ui-state';
import type { FeedbackDraftTask, FeedbackDraftTaskGeneration } from '../contracts/feedback-draft';
import './feedback.css';
import './redesign-business.css';
import { formatDate } from '../shared/date-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type FeedbackDraft = { studentId: string; title: string; content: string };

function readFeedbackContext() {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const studentId = query.get('studentId')?.trim() || undefined;
  const recordId = query.get('recordId')?.trim() || undefined;
  return { studentId, recordId };
}

export function FeedbackPage({ actions }: { actions: PreviewActions }) {
  const context = readFeedbackContext();
  const create = () => actions.open('新建反馈草稿', <FeedbackForm actions={actions} initialStudentId={context.studentId} sourceRecordId={context.recordId} />);
  const [tasks, setTasks] = useState<FeedbackDraftTask[]>([]);
  const [taskError, setTaskError] = useState('');
  const [loadingTasks, setLoadingTasks] = useState(Boolean(actions.listFeedbackDraftTasks));
  const loadTasks = async () => {
    if (!actions.listFeedbackDraftTasks) return;
    setLoadingTasks(true);
    try {
      const items = await actions.listFeedbackDraftTasks();
      setTasks(items.filter((item) => item.status !== 'saved'));
      setTaskError('');
    } catch (failure) {
      setTaskError(messageOf(failure, '未保存草稿加载失败，请刷新后重试。'));
    } finally { setLoadingTasks(false); }
  };
  useEffect(() => { void loadTasks(); }, [actions.listFeedbackDraftTasks]);
  const edit = (feedback: Feedback) => actions.open('编辑反馈草稿', <FeedbackForm feedback={feedback} actions={actions} />);
  const continueTask = (task: FeedbackDraftTask) => actions.open('继续未保存草稿', <FeedbackForm actions={actions} initialTask={task} />);
  const copy = async (feedback: Feedback) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(`${feedback.title}\n${feedback.content}`);
      actions.toast('已复制');
    } catch {
      actions.toast('未能复制，请选中草稿文字手动复制。', 'warn');
    }
  };
  const viewEvidence = (feedback: Feedback) => {
    if (!actions.viewFeedbackSnapshot) return;
    actions.open('反馈依据', <FeedbackEvidencePanel feedback={feedback} loadSnapshot={() => actions.viewFeedbackSnapshot!(feedback.id)} />);
  };
  return <section className="page preview-page"><header className="page-header"><div><h1>家长反馈</h1><p>整理反馈草稿，编辑完成后复制使用。</p></div><Button onClick={create}>新建反馈</Button></header>
    {actions.listFeedbackDraftTasks && <section className="feedback-draft-tasks" aria-label="未保存反馈草稿"><div className="feedback-draft-tasks-heading"><div><h2>继续未保存草稿</h2><p>草稿和生成状态已保存在你的工作台，刷新、重新登录或换设备后都可以继续。</p></div><Button type="button" variant="outline" size="sm" onClick={() => void loadTasks()} disabled={loadingTasks}>{loadingTasks ? '正在刷新…' : '刷新草稿'}</Button></div>{taskError && <p className="form-error" role="alert">{taskError}</p>}{!loadingTasks && !taskError && (tasks.length ? <div className="feedback-draft-task-list">{tasks.map((task) => <Card key={task.id} className="white-card feedback-draft-task"><CardContent><div><strong>{studentName(actions.data, task.studentId)}</strong><p>{taskDraft(task).title || '未命名反馈草稿'} · {taskLabel(task.status)}</p>{task.error && <small>{task.error.message}</small>}</div><Button type="button" variant="outline" onClick={() => continueTask(task)}>继续编辑</Button></CardContent></Card>)}</div> : <p className="form-hint">当前没有未保存的反馈草稿。</p>)}</section>}
    <div className="feedback-list">{actions.data.feedbacks.length ? actions.data.feedbacks.map((feedback) => <Card className="white-card" key={feedback.id}><CardContent><div className="feedback-meta"><div><h2>{feedback.title}</h2><p>{studentName(actions.data, feedback.studentId)} · {feedback.status || '草稿'} · <time dateTime={feedback.updatedAt}>{formatDate(feedback.updatedAt)}</time></p></div><Badge variant="secondary">{feedback.status || '草稿'}</Badge></div><p className="feedback-body">{feedback.content}</p><div className="button-row">{actions.viewFeedbackSnapshot && <Button variant="outline" size="sm" onClick={() => viewEvidence(feedback)}>查看依据</Button>}{feedback.status !== '已发送' && <Button variant="outline" size="sm" onClick={() => edit(feedback)}>编辑草稿</Button>}<Button variant="outline" size="sm" onClick={() => copy(feedback)}>复制草稿</Button></div></CardContent></Card>) : <Card className="white-card feedback-empty"><CardContent><h2>还没有反馈草稿</h2><p>选择一名学生，开始整理一份反馈。</p><Button onClick={create}>新建反馈</Button></CardContent></Card>}</div></section>;
}

function FeedbackEvidencePanel({ feedback, loadSnapshot }: { feedback: Feedback; loadSnapshot: () => Promise<FeedbackSnapshot> }) {
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void loadSnapshot().then((result) => { if (active) setSnapshot(result); }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : '依据加载失败，请稍后重试。');
    });
    return () => { active = false; };
  }, [loadSnapshot]);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!snapshot) return <p role="status">正在加载反馈依据…</p>;
  return <div className="feedback-evidence-panel"><p className="form-hint">{feedback.title} · 组装于 {formatDate(snapshot.assembledAt)}{snapshot.windowStart && snapshot.windowEnd ? ` · 范围 ${formatDate(snapshot.windowStart)} 至 ${formatDate(snapshot.windowEnd)}` : ''}</p>{snapshot.evidence.length ? <ul aria-label="反馈依据列表">{snapshot.evidence.map((item) => <EvidenceItem key={`${item.id}-${item.sourceVersion || ''}`} item={item} />)}</ul> : <p>这份反馈没有保存可回看的依据快照。</p>}</div>;
}

function EvidenceItem({ item }: { item: FeedbackEvidenceItem }) {
  const sourceLabel = item.type === 'assessment' ? '测评' : item.type === 'lesson' ? '课程' : '教学记录';
  return <li><div><Badge variant="outline">{sourceLabel}</Badge><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>{item.originalDeleted && <Badge variant="secondary">原始材料已删除</Badge>}</div><p>{item.summary || '未保存摘要'}</p>{item.subject && <small>科目：{item.subject}</small>}</li>;
}

function FeedbackForm({ feedback, actions, initialStudentId, sourceRecordId, initialTask }: { feedback?: Feedback; actions: PreviewActions; initialStudentId?: string; sourceRecordId?: string; initialTask?: FeedbackDraftTask }) {
  const draftKey = initialTask ? `feedback.task.${initialTask.id}` : feedback ? `feedback.edit.${feedback.id}` : `feedback.new.draft.${sourceRecordId || initialStudentId || 'empty'}`;
  const initialTaskDraft = initialTask ? taskDraft(initialTask) : null;
  const initial: FeedbackDraft = { studentId: initialTask?.studentId || feedback?.studentId || initialStudentId || '', title: initialTaskDraft?.title || feedback?.title || '', content: initialTaskDraft?.content || feedback?.content || '' };
  const [draft, setDraft] = usePreviewState(actions, draftKey, initial);
  const [task, setTask] = useState<FeedbackDraftTask | null>(initialTask || null);
  const [generating, setGenerating] = useState(initialTask?.status === 'running');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(initialTask?.error?.message || '');
  const dirtyRef = useRef(false);
  const createRequestId = useRef<string | undefined>(undefined);
  const retryRequestId = useRef<string | undefined>(undefined);

  const hydrateTask = (next: FeedbackDraftTask, preserveLocalDraft = false) => {
    const nextDraft = taskDraft(next);
    setTask(next);
    if (!preserveLocalDraft) {
      setDraft({ studentId: next.studentId, title: nextDraft.title, content: nextDraft.content });
      dirtyRef.current = false; setDirty(false);
    }
    setGenerating(next.status === 'running'); setError(next.error?.message || '');
  };
  useEffect(() => {
    // 即使当前浏览器残留 session UI，恢复任务时仍以服务端任务为准。
    if (initialTask) hydrateTask(initialTask);
  }, [initialTask?.id]);
  useEffect(() => {
    if (!task || task.status !== 'running' || !actions.getFeedbackDraftTask) return;
    let active = true;
    const refresh = () => actions.getFeedbackDraftTask!(task.id).then((next) => { if (active) hydrateTask(next, dirtyRef.current); }).catch((failure) => { if (active) setError(messageOf(failure, '生成状态刷新失败，请稍后刷新草稿。')); });
    void refresh();
    const timer = window.setInterval(refresh, 1800);
    return () => { active = false; window.clearInterval(timer); };
  }, [task?.id, task?.status, actions.getFeedbackDraftTask]);
  const set = (patch: Partial<FeedbackDraft>) => {
    setDraft({ ...draft, ...patch });
    if (task) { dirtyRef.current = true; setDirty(true); }
    setError('');
  };
  const persist = async () => {
    if (!task || !dirty || !actions.updateFeedbackDraftTask) return task;
    try {
      const next = await actions.updateFeedbackDraftTask(task.id, { expectedVersion: task.version, title: draft.title.trim(), content: draft.content.trim() });
      hydrateTask(next);
      actions.toast('修改已暂存');
      return next;
    } catch (failure) {
      if (errorCode(failure) === 'VERSION_CONFLICT') setError('草稿已在其他页面更新，请刷新草稿后再继续编辑。');
      else setError(messageOf(failure, '暂存修改失败，请重试。'));
      throw failure;
    }
  };
  const prepare = async () => {
    const studentId = draft.studentId.trim();
    if (!studentId) { setError('请先选择学生，再生成反馈。'); return; }
    if (task?.status === 'evidence_changed') { setError('生成依据已经变化，请重新新建并核对材料，不能沿用旧依据。'); return; }
    setGenerating(true); setError('');
    try {
      if (!actions.createFeedbackDraftTask) return setError('反馈生成服务尚未连接，请手工编写。');
      createRequestId.current ||= crypto.randomUUID();
      const receipt = await actions.createFeedbackDraftTask({ clientRequestId: createRequestId.current, studentId, ...(sourceRecordId ? { recordIds: [sourceRecordId] } : {}), title: draft.title, content: draft.content });
      hydrateTask(receipt.task);
      retryRequestId.current = undefined;
    } catch (failure) { setError(messageOf(failure, '反馈生成未完成，请稍后重试。')); }
    finally { setGenerating(false); }
  };
  const retryGeneration = async () => {
    if (!task || !actions.retryFeedbackDraftTask) return;
    setGenerating(true); setError('');
    try {
      retryRequestId.current ||= crypto.randomUUID();
      const receipt = await actions.retryFeedbackDraftTask(task.id, { clientRequestId: retryRequestId.current, expectedVersion: task.version });
      hydrateTask(receipt.task, dirtyRef.current);
      // 收到权威回执后本次幂等请求已经结束；即使仍失败，下次点击也必须是一次新尝试。
      retryRequestId.current = undefined;
    } catch (failure) { setError(messageOf(failure, '重试生成未完成，请稍后重试。')); }
    finally { setGenerating(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const studentId = draft.studentId.trim(); const title = draft.title.trim(); const content = draft.content.trim();
    if (!studentId || !title || !content) return setError('学生、标题和正文不能为空。');
    if (!actions.data.students.some((student) => student.id === studentId)) return setError('请选择一名有效学生。');
    if (task && task.status !== 'succeeded') return setError(task.status === 'evidence_changed' ? '生成依据已经变化，请重新新建并核对材料，不能保存为沿用旧依据的反馈。' : '这份生成任务尚未成功完成。请等待处理完成或重试生成；你也可以关闭后新建纯手工反馈。');
    setSaving(true);
    try {
      const persistedTask = await persist();
      const savedDraft: FeedbackSaveInput = { studentId, title, content, id: feedback?.id };
      if (persistedTask?.status === 'succeeded') savedDraft.generationTaskId = persistedTask.id;
      if (actions.saveFeedback) {
        await actions.saveFeedback(savedDraft);
      } else if (feedback) actions.setData((old) => ({ ...old, feedbacks: old.feedbacks.map((item) => item.id === feedback.id ? { ...item, studentId, title, content, updatedAt: today } : item) }));
      else actions.setData((old) => ({ ...old, feedbacks: [{ id: `f-${Date.now()}`, studentId, title, content, updatedAt: today }, ...old.feedbacks] }));
      setDraft(feedback ? { studentId, title, content } : { studentId: '', title: '', content: '' }); actions.close(); actions.toast('已保存');
    } catch (failure) { setError(messageOf(failure, '保存未完成，请重试。')); }
    finally { setSaving(false); }
  };
  const taskBlocksSave = Boolean(task && task.status !== 'succeeded');
  const taskAllowsRetry = Boolean(task && task.retryable && task.status !== 'evidence_changed' && actions.retryFeedbackDraftTask);
  return <form className="feedback-editor" onSubmit={(event) => void save(event)}>
    {!feedback && <label>学生<select aria-label="选择学生" value={draft.studentId} disabled={Boolean(task)} onChange={(event) => set({ studentId: event.target.value })}><option value="">请选择学生</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>}
    {task && <p className="form-hint">此草稿已关联 {studentName(actions.data, task.studentId)}。为保证依据一致，如需换学生请关闭后新建反馈。</p>}
    {!feedback && actions.createFeedbackDraftTask && <div className="button-row"><Button type="button" variant="outline" onClick={() => void prepare()} disabled={generating || Boolean(task) || !draft.studentId}>{generating ? '正在生成…' : '根据教学记录生成反馈'}</Button><span className="form-hint">生成结果只会填入待核对表单，保存仍需你明确确认。</span></div>}
    {!feedback && sourceRecordId && <p className="form-hint">已带入刚刚核对的正式记录，生成时只使用这条记录作为依据。</p>}
    {task?.status === 'running' && <p role="status" className="form-hint">正在由服务端生成反馈。关闭后也可以从“继续未保存草稿”回来查看结果。</p>}
    {(task?.status === 'failed' || task?.status === 'uncertain') && <p className="form-hint">当前任务会保留，方便核对或重试。若要完全手工写一份反馈，请关闭后新建反馈，避免丢失这次生成任务的状态。</p>}
    {task?.status === 'evidence_changed' && <p className="form-error" role="alert">生成依据已经变化。请重新新建反馈并核对材料，当前草稿不能继续冒充旧依据。</p>}
    {task?.status === 'uncertain' && <p className="form-error" role="alert">生成结果状态不确定，请重试生成，收到成功结果并重新核对后再保存。</p>}
    <label>标题<Input value={draft.title} onChange={(event) => set({ title: event.target.value })} required /></label><label>正文<Textarea value={draft.content} onChange={(event) => set({ content: event.target.value })} required /></label>
    {task?.generation && <FeedbackGenerationContext generation={task.generation} />}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">{task && dirty && actions.updateFeedbackDraftTask && <Button type="button" variant="outline" onClick={() => void persist()} disabled={saving || generating}>暂存修改</Button>}{taskAllowsRetry && <Button type="button" variant="outline" onClick={() => void retryGeneration()} disabled={generating || saving}>{generating ? '正在重试…' : '重试生成'}</Button>}<Button type="button" variant="outline" onClick={actions.close} disabled={saving}>取消</Button><Button disabled={generating || saving || taskBlocksSave}>{saving ? '正在保存…' : '保存草稿'}</Button></div>
  </form>;
}

function taskLabel(status: FeedbackDraftTask['status']) {
  return ({ running: '正在生成', succeeded: '待保存', failed: '生成失败', evidence_changed: '依据已变化', uncertain: '等待核对', saved: '已保存' } as const)[status];
}

function errorCode(failure: unknown) {
  return failure && typeof failure === 'object' && 'error' in failure && (failure as { error?: { code?: unknown } }).error?.code;
}

function messageOf(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

function taskDraft(task: FeedbackDraftTask) {
  return task.draft || { title: task.request.title || '', content: task.request.content || '' };
}

function FeedbackGenerationContext({ generation }: { generation: FeedbackDraftTaskGeneration }) {
  return <div className="feedback-generation-context" aria-label="反馈生成依据"><p><b>生成说明：</b>{generation.rationale}</p><p className="form-hint">本次使用 {generation.evidence?.length || 0} 条已核对依据，范围 {generation.windowStart ? formatDate(generation.windowStart) : '未记录'} 至 {generation.windowEnd ? formatDate(generation.windowEnd) : '未记录'}。</p></div>;
}

export { SettingsPage } from './SettingsConfiguration';
