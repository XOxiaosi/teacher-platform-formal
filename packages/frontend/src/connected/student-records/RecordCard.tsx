import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { reviewStudentRecord } from '../../api/students';
import type { StudentRecordItem } from '../../api/types';
import { RecordSource } from './RecordSource';
import { RecordDetails } from './RecordDetails';
import { displayTime, messageOf } from './load-records';

interface Props {
  teacherId: string;
  studentId: string;
  record: StudentRecordItem;
  sourceEpoch: number;
  disabled: boolean;
  onSaved: (record: StudentRecordItem) => Promise<void>;
  onRefresh: () => Promise<StudentRecordItem | null>;
}
const visibilityLabels: Record<string, string> = { internal_only: '仅教师可见', parent_shareable: '允许用于家长表达', needs_review: '分享前需核对' };
const reviewLabels: Record<string, string> = { candidate: '待确认', confirmed: '已确认', rejected: '已拒绝', superseded: '已被新记录替代' };
const categoryLabels: Record<string, string> = {
  general_note: '教学备注', assessment: '成绩记录', parent_communication: '家长沟通', lesson_observation: '课堂观察',
  learning_state: '学习状态', goal: '学习目标', achievement: '成长收获', concern: '待关注事项',
  agreement: '约定事项', follow_up: '后续跟进', homework: '作业记录',
};

export function RecordCard({ teacherId, studentId, record, sourceEpoch, disabled, onSaved, onRefresh }: Props) {
  const [displayed, setDisplayed] = useState(record);
  const current = useRef(record);
  const [visibility, setVisibility] = useState(record.visibility);
  const [review, setReview] = useState<'confirmed' | 'rejected'>('confirmed');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [recovery, setRecovery] = useState<'required' | 'loaded' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (current.current.updatedAt !== record.updatedAt) {
      setRecovery('loaded'); setError('记录已有更新，已保留你的选择。请核对最新内容后再操作。');
      if (visibility === current.current.visibility) setVisibility(record.visibility);
    }
    current.current = record; setDisplayed(record);
  }, [record]);
  const confirmed = displayed.reviewStatus === 'confirmed';
  const editable = ['candidate', 'confirmed', 'rejected'].includes(displayed.reviewStatus);
  const targetReview = confirmed ? 'confirmed' : review;
  const unchanged = targetReview === displayed.reviewStatus && visibility === displayed.visibility;

  const save = async () => {
    if (busyRef.current || disabled || recovery || !editable || unchanged) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await reviewStudentRecord(teacherId, studentId, displayed.id, targetReview, visibility, displayed.updatedAt);
      if (!live.current) return;
      if (result.id !== displayed.id || result.teacherId !== teacherId || result.studentId !== studentId
        || result.reviewStatus !== targetReview || result.visibility !== visibility || !Number.isFinite(Date.parse(result.updatedAt))) {
        throw new Error('保存回执无法核对，请刷新记录确认当前状态。');
      }
      current.current = result; setDisplayed(result); setVisibility(result.visibility); setReview('confirmed');
      setMessage('已保存。分享范围只表示教师授权，不代表已经发送给家长。');
      try { await onSaved(result); } catch {
        if (live.current) setMessage('已保存，其他页面暂未刷新。请刷新资料，无需重复保存。');
      }
    } catch (cause) {
      if (!live.current) return;
      const explicitRejection = cause instanceof ApiError && [400, 404].includes(cause.status ?? 0);
      setError(`${messageOf(cause)}${explicitRejection ? '' : ' 请先刷新并核对记录，不能直接重复保存。'}`);
      if (!explicitRejection) setRecovery('required');
    } finally {
      if (live.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const result = await onRefresh();
      if (!live.current) return;
      if (!result) { setError('未能读取这条记录的最新状态，请重新刷新核对。'); return; }
      current.current = result; setDisplayed(result); setRecovery('loaded');
      setError('已读取最新记录，已保留你的选择。请核对下方状态与内容。');
    } catch (cause) { if (live.current) setError(messageOf(cause)); }
    finally { if (live.current) { busyRef.current = false; setBusy(false); } }
  };
  return <article className="formal-record-card" aria-label={`${categoryLabels[displayed.category] ?? displayed.category}记录`}>
    <header><h3>{categoryLabels[displayed.category] ?? displayed.category}</h3><span>{reviewLabels[displayed.reviewStatus] ?? displayed.reviewStatus}</span></header>
    <p className="record-meta">发生时间：<time dateTime={displayed.occurredAt}>{displayTime(displayed.occurredAt)}</time><br />
      保存时间：<time dateTime={displayed.createdAt}>{displayTime(displayed.createdAt)}</time><br />
      更新时间：<time dateTime={displayed.updatedAt}>{displayTime(displayed.updatedAt)}</time></p>
    <h4>记录内容</h4><p className="record-full-text">{displayed.summary}</p>
    <RecordDetails data={displayed.structuredData} version={displayed.updatedAt} supersedesId={displayed.supersedesId} />
    <p>审核状态：{reviewLabels[displayed.reviewStatus] ?? displayed.reviewStatus}<br />分享范围：{visibilityLabels[displayed.visibility] ?? displayed.visibility}</p>
    <RecordSource teacherId={teacherId} studentId={studentId} recordId={displayed.id} sourceRecordId={displayed.sourceRecordId} epoch={sourceEpoch} />
    {editable && <div className="record-review-controls">
      {!confirmed && <label>审核结果<select value={review} disabled={busy || disabled || !!recovery} onChange={(event) => { setReview(event.target.value as 'confirmed' | 'rejected'); setMessage(''); }}>
        <option value="confirmed">确认记录</option>{displayed.reviewStatus === 'candidate' && <option value="rejected">拒绝记录</option>}
      </select></label>}
      <label>调整分享范围<select value={visibility} disabled={busy || disabled || !!recovery} onChange={(event) => { setVisibility(event.target.value); setMessage(''); }}>
        {Object.entries(visibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <p className="record-meta">选择“允许用于家长表达”后，需点击保存。来源失效的内容仍需重新核对。</p>
      <button className="button secondary" disabled={busy || disabled || !!recovery || unchanged} onClick={() => void save()}>{busy ? '处理中…' : confirmed ? '保存分享范围' : '保存审核结果'}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {recovery && <div className="button-row">
      <button className="button secondary" disabled={busy} onClick={() => void refresh()}>刷新并核对记录</button>
      {recovery === 'loaded' && <button className="button secondary" disabled={busy || disabled} onClick={() => { setRecovery(null); setError(''); setMessage(unchanged ? '当前记录已是所选状态，无需重复保存。' : '已核对最新记录，请确认是否保存所选范围。'); }}>已核对，保留选择继续</button>}
    </div>}
  </article>;
}
