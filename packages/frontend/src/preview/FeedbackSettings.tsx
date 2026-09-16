import { FormEvent, useState } from 'react';
import { PreviewActions, studentName, type FeedbackSaveInput, type GenerateFeedbackDraftResult } from './PreviewApp';
import { Feedback, today } from './data';
import { usePreviewState } from './ui-state';
import './feedback.css';
import { commitAction } from './action-result';

type FeedbackDraft = { studentId: string; title: string; content: string };

export function FeedbackPage({ actions }: { actions: PreviewActions }) {
  const create = () => actions.open('新建反馈草稿', <FeedbackForm actions={actions} />);
  const edit = (feedback: Feedback) => actions.open('编辑反馈草稿', <FeedbackForm feedback={feedback} actions={actions} />);
  const copy = async (feedback: Feedback) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(`${feedback.title}\n${feedback.content}`);
      actions.toast('已复制');
    } catch {
      actions.toast('未能复制，请选中草稿文字手动复制。', 'warn');
    }
  };
  return <section className="page preview-page"><header className="page-header"><div><h1>家长反馈</h1><p>整理反馈草稿，编辑完成后复制使用。</p></div><button className="button primary" onClick={create}>新建反馈</button></header><div className="feedback-list">{actions.data.feedbacks.length ? actions.data.feedbacks.map((feedback) => <article className="white-card" key={feedback.id}><div className="feedback-meta"><div><h2>{feedback.title}</h2><p>{studentName(actions.data, feedback.studentId)} · {feedback.status || '草稿'} · {feedback.updatedAt}</p></div><span>{feedback.status || '草稿'}</span></div><p className="feedback-body">{feedback.content}</p><div className="button-row">{feedback.status !== '已发送' && <button className="button secondary small" onClick={() => edit(feedback)}>编辑草稿</button>}<button className="button secondary small" onClick={() => copy(feedback)}>复制草稿</button></div></article>) : <div className="white-card feedback-empty"><h2>还没有反馈草稿</h2><p>选择一名学生，开始整理一份反馈。</p><button className="button primary" onClick={create}>新建反馈</button></div>}</div></section>;
}

function FeedbackForm({ feedback, actions }: { feedback?: Feedback; actions: PreviewActions }) {
  const draftKey = feedback ? `feedback.edit.${feedback.id}` : 'feedback.new.draft';
  const initial: FeedbackDraft = { studentId: feedback?.studentId || '', title: feedback?.title || '', content: feedback?.content || '' };
  const [draft, setDraft] = usePreviewState(actions, draftKey, initial);
  const [generated, setGenerated] = useState<GenerateFeedbackDraftResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<FeedbackDraft>) => { setDraft({ ...draft, ...patch }); setError(''); };
  const prepare = async () => {
    const studentId = draft.studentId.trim();
    if (!studentId) { setError('请先选择学生，再生成反馈。'); return; }
    if (!actions.generateFeedbackDraft) { setError('反馈生成服务尚未连接，请手工编写。'); return; }
    setGenerating(true); setError('');
    try {
      const result = await actions.generateFeedbackDraft({ studentId });
      setGenerated(result);
      setDraft({ studentId: result.studentId, title: result.title, content: result.content });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '反馈生成未完成，请稍后重试。');
    } finally { setGenerating(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const studentId = draft.studentId.trim(); const title = draft.title.trim(); const content = draft.content.trim();
    if (!studentId || !title || !content) return setError('学生、标题和正文不能为空。');
    if (!actions.data.students.some((student) => student.id === studentId)) return setError('请选择一名有效学生。');
    const savedDraft: FeedbackSaveInput = { studentId, title, content, id: feedback?.id };
    if (generated && generated.studentId === studentId) Object.assign(savedDraft, {
      lessonId: generated.lessonIds[0], evidence: generated.evidence, windowStart: generated.windowStart, windowEnd: generated.windowEnd,
    });
    if (actions.saveFeedback) return commitAction(actions, () => actions.saveFeedback!(savedDraft), () => { setDraft(feedback ? { studentId, title, content } : { studentId: '', title: '', content: '' }); actions.close(); actions.toast('已保存'); });
    if (feedback) actions.setData((old) => ({ ...old, feedbacks: old.feedbacks.map((item) => item.id === feedback.id ? { ...item, studentId, title, content, updatedAt: today } : item) })); else actions.setData((old) => ({ ...old, feedbacks: [{ id: `f-${Date.now()}`, studentId, title, content, updatedAt: today }, ...old.feedbacks] }));
    setDraft(feedback ? { studentId, title, content } : { studentId: '', title: '', content: '' }); actions.close(); actions.toast('已保存');
  };
  return <form className="feedback-editor" onSubmit={save}>
    {!feedback && <label>学生<select aria-label="选择学生" value={draft.studentId} onChange={(event) => set({ studentId: event.target.value })}><option value="">请选择学生</option>{actions.data.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>}
    {actions.generateFeedbackDraft && !feedback && <div className="button-row"><button type="button" className="button secondary" onClick={() => void prepare()} disabled={generating || !draft.studentId}>{generating ? '正在生成…' : '根据教学记录生成反馈'}</button><span className="form-hint">生成结果只会填入待核对表单，保存仍需你明确确认。</span></div>}
    <label>标题<input value={draft.title} onChange={(event) => set({ title: event.target.value })} required /></label><label>正文<textarea value={draft.content} onChange={(event) => set({ content: event.target.value })} required /></label>
    {generated && <div className="feedback-generation-context" aria-label="反馈生成依据"><p><b>生成说明：</b>{generated.rationale}</p><p className="form-hint">本次使用 {generated.evidence?.length || 0} 条已核对依据，范围 {generated.windowStart || '未记录'} 至 {generated.windowEnd || '未记录'}。</p></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={actions.close}>取消</button><button className="button primary" disabled={generating}>保存草稿</button></div>
  </form>;
}

export { SettingsPage } from './SettingsConfiguration';
