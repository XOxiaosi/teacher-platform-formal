import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudentRecordItem } from '../../api/types';
import { RecordCard } from './RecordCard';
import { loadRecords, messageOf } from './load-records';
import './student-records.css';

export interface StudentRecordPanelProps {
  teacherId: string;
  studentId: string;
  refreshToken?: unknown;
  onRecordsChanged?: () => Promise<void>;
}

export function StudentRecordPanel(props: StudentRecordPanelProps) {
  return <ScopedRecordPanel key={`${props.teacherId}:${props.studentId}`} {...props} />;
}

function ScopedRecordPanel({ teacherId, studentId, refreshToken, onRecordsChanged }: StudentRecordPanelProps) {
  const [records, setRecords] = useState<StudentRecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceEpoch, setSourceEpoch] = useState(0);
  const live = useRef(false);
  const sequence = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; sequence.current += 1; }; }, []);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const result = await loadRecords(teacherId, studentId);
      if (!live.current || request !== sequence.current) return null;
      setRecords(result); setSourceEpoch((old) => old + 1);
      return result;
    } catch (cause) {
      if (live.current && request === sequence.current) setError(messageOf(cause));
      return null;
    } finally {
      if (live.current && request === sequence.current) setLoading(false);
    }
  }, [teacherId, studentId]);
  useEffect(() => { void reload(); }, [reload, refreshToken]);
  const changed = async (record: StudentRecordItem) => {
    if (!live.current) return;
    setRecords((old) => old.map((item) => item.id === record.id ? record : item));
    setSourceEpoch((old) => old + 1);
    if (onRecordsChanged) await onRecordsChanged();
  };
  return <section className="student-record-panel" aria-label="正式学生记录">
    <div className="record-panel-heading"><h2>已保存记录</h2><button className="button secondary small" onClick={() => void reload()} disabled={loading}>刷新记录</button></div>
    {loading && <p role="status">正在读取全部记录…</p>}
    {error && <p role="alert">本次未能读取完整记录。{error}{records.length > 0 && ' 下方保留上次记录，请刷新核对后再操作。'}</p>}
    {!loading && !error && <p className="record-count">共 {records.length} 条记录 · 时间均为北京时间</p>}
    {!loading && !error && !records.length && <p className="empty">暂无已保存记录</p>}
    {records.map((record) => <RecordCard key={record.id} teacherId={teacherId} studentId={studentId}
      record={record} sourceEpoch={sourceEpoch} disabled={loading || !!error} onSaved={changed}
      onRefresh={async () => (await reload())?.find((item) => item.id === record.id) ?? null} />)}
  </section>;
}
