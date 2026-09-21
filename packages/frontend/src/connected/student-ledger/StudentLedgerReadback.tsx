import { useCallback, useEffect, useRef, useState } from 'react';
import { getStudentBalance } from '../../api/students';
import { listLessonLedgerEntries } from '../../api/payments';
import type { LessonBalance, LessonLedgerEntryData } from '../../api/types';
import { formatDateTime } from '../../shared/date-format';
import './student-ledger.css';

export interface StudentLedgerReadbackProps {
  teacherId: string;
  studentId: string;
  refreshToken?: unknown;
}

const ENTRY_LABELS: Record<string, string> = {
  purchase: '购课',
  attendance_deduction: '上课扣除',
  attendance_reversal: '出勤回退',
  refund: '退款调整',
  gift: '赠课',
  manual_adjustment: '人工调整',
};

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '请稍后重试。';
}

function formatDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${value} 课时`;
}

function entryDescription(entry: LessonLedgerEntryData): string {
  if (entry.reason) return entry.reason;
  if (entry.entryType === 'purchase') return entry.amount === null ? '缴费入账' : `缴费入账 · ¥${entry.amount}`;
  if (entry.entryType === 'attendance_deduction') return '课程完成后扣除';
  if (entry.entryType === 'attendance_reversal') return '课次状态更正后回退';
  return '已确认的课时调整';
}

function StudentLedgerReadbackScoped({ teacherId, studentId, refreshToken }: StudentLedgerReadbackProps) {
  const [balance, setBalance] = useState<LessonBalance | null>(null);
  const [entries, setEntries] = useState<LessonLedgerEntryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; sequence.current += 1; };
  }, []);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setBalance(null);
    setEntries([]);
    try {
      const [nextBalance, nextEntries] = await Promise.all([
        getStudentBalance(teacherId, studentId),
        listLessonLedgerEntries(teacherId, { studentId }),
      ]);
      if (!live.current || request !== sequence.current) return;
      setBalance(nextBalance);
      setEntries(nextEntries);
    } catch (cause) {
      if (live.current && request === sequence.current) setError(messageOf(cause));
    } finally {
      if (live.current && request === sequence.current) setLoading(false);
    }
  }, [teacherId, studentId]);

  useEffect(() => { void reload(); }, [reload, refreshToken]);

  return (
    <section className="student-ledger-readback" aria-label="学生课时账户">
      <header className="student-ledger-heading">
        <div>
          <p className="student-ledger-eyebrow">课时账户</p>
          <h2>余额与流水</h2>
          <p className="student-ledger-caption">以不可变课时流水为准，时间均为北京时间</p>
        </div>
        <button className="button secondary small" type="button" onClick={() => void reload()} disabled={loading}>
          刷新
        </button>
      </header>

      {loading && <p className="student-ledger-state" role="status">正在读取课时账户…</p>}
      {error && (
        <div className="student-ledger-error" role="alert">
          <p>课时账户读取失败：{error}</p>
          <button className="button secondary small" type="button" onClick={() => void reload()}>重试</button>
        </div>
      )}

      {!loading && !error && balance && (
        <>
          <dl className="student-ledger-balance" aria-label="课时余额汇总">
            <div><dt>已购课时</dt><dd>{balance.purchased}</dd></div>
            <div><dt>已消耗</dt><dd>{balance.attended}</dd></div>
            <div><dt>调整课时</dt><dd>{balance.adjustments > 0 ? `+${balance.adjustments}` : balance.adjustments}</dd></div>
            <div className="student-ledger-balance-total"><dt>当前剩余</dt><dd>{balance.remaining}<small>课时</small></dd></div>
          </dl>
          <div className="student-ledger-list-heading">
            <h3>课时流水</h3><span>{entries.length} 条</span>
          </div>
          {!entries.length && <p className="student-ledger-empty">暂无课时流水记录</p>}
          {!!entries.length && (
            <ol className="student-ledger-entries" aria-label="课时流水记录">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <div className="student-ledger-entry-main">
                    <strong>{ENTRY_LABELS[entry.entryType] ?? '课时变动'}</strong>
                    <span className={entry.lessonDelta >= 0 ? 'is-positive' : 'is-negative'}>{formatDelta(entry.lessonDelta)}</span>
                  </div>
                  <div className="student-ledger-entry-meta">
                    <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                    <span>{entryDescription(entry)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

export function StudentLedgerReadback(props: StudentLedgerReadbackProps) {
  return <StudentLedgerReadbackScoped key={`${props.teacherId}:${props.studentId}`} {...props} />;
}
