import { useEffect, useRef, useState } from 'react';
import { getStudentRecordSource } from '../../api/students';
import type { StudentRecordSource } from '../../api/types';
import { displayTime, messageOf } from './load-records';

export function RecordSource({ teacherId, studentId, recordId, sourceRecordId, epoch }: {
  teacherId: string; studentId: string; recordId: string; sourceRecordId: string | null; epoch: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StudentRecordSource | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [sourceState, setSourceState] = useState<StudentRecordSource['state'] | null>(null);
  const generation = useRef(0);
  useEffect(() => { setSourceState(null); }, [teacherId, studentId, recordId, sourceRecordId, epoch]);
  useEffect(() => {
    const current = ++generation.current;
    setData(null); setError('');
    if (open && sourceRecordId) {
      void getStudentRecordSource(teacherId, studentId, recordId).then((result) => {
        if (current !== generation.current) return;
        if (result.recordId !== recordId || (result.source && result.source.id !== sourceRecordId)) throw new Error('来源归属不匹配，请刷新记录。');
        setData(result); setSourceState(result.state);
      }).catch((cause) => { if (current === generation.current) setError(messageOf(cause)); });
    }
    return () => { generation.current += 1; };
  }, [teacherId, studentId, recordId, sourceRecordId, epoch, open, retry]);
  if (!sourceRecordId) return <p className="record-source-status">来源：无关联来源材料</p>;
  return <section className="record-source">
    {sourceState === 'deleted' && <p className="record-source-status">来源状态：原件已删除</p>}
    {sourceState === 'unavailable' && <p className="record-source-status">来源状态：当前不可用</p>}
    {sourceState === 'available' && <p className="record-source-status">来源状态：原文可查看</p>}
    <button className="button secondary small" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '收起来源原文' : '查看来源原文'}</button>
    {open && <div>
      <h4>来源原文</h4>
      {!data && !error && <p role="status">正在读取来源…</p>}
      {error && <p role="alert">来源读取失败：{error} <button className="button text-button" onClick={() => setRetry((old) => old + 1)}>重试读取来源</button></p>}
      {data?.state === 'deleted' && <p>来源材料已删除，原文不可查看。已确认的记录内容仍保留。</p>}
      {data?.state === 'none' && <p>无关联来源材料。</p>}
      {data?.state === 'unavailable' && <p>来源当前不可用，不能核对原文。</p>}
      {data?.source && <p className="record-meta">来源类型：{typeLabel(data.source.sourceType)} · 来源状态：{sourceLabel(data.source.captureStatus)}<br />发生：{displayTime(data.source.occurredAt)} · 更新：{displayTime(data.source.updatedAt)}</p>}
      {data?.state === 'available' && <p className="record-full-text">{data.source?.rawText ?? '来源未提供文本原文。'}</p>}
    </div>}
  </section>;
}

function sourceLabel(value: string): string {
  return ({ captured: '已采集', unresolved: '待归属', archived: '已归档', deleted: '已删除', failed: '采集失败' } as Record<string, string>)[value] ?? '未知状态';
}

function typeLabel(value: string): string {
  return ({ agent_text: '助手整理文本', manual: '教师录入', lesson: '课程记录', assessment: '成绩材料', audio: '音频材料', image: '图片材料', screenshot: '截图材料', import: '导入材料', text: '文本材料' } as Record<string, string>)[value] ?? '其他来源';
}
