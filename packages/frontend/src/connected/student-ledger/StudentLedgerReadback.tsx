import { useCallback, useEffect, useRef, useState } from 'react';
import { getStudentBalance } from '../../api/students';
import {
  confirmLessonLedgerAdjustment,
  listLessonLedgerEntries,
  prepareLessonLedgerAdjustment,
} from '../../api/payments';
import type {
  LessonBalance,
  LessonLedgerAdjustmentEntryType,
  LessonLedgerEntryData,
  PrepareLessonLedgerAdjustmentRequest,
  PrepareLessonLedgerAdjustmentResult,
} from '../../api/types';
import { formatDateTime } from '../../shared/date-format';
import './student-ledger.css';

export interface StudentLedgerReadbackProps {
  teacherId: string;
  studentId: string;
  refreshToken?: unknown;
  onLedgerChanged?: () => Promise<void>;
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

type AdjustmentForm = {
  entryType: LessonLedgerAdjustmentEntryType;
  quantity: string;
  manualDirection: 'increase' | 'decrease';
  reason: string;
};

const INITIAL_ADJUSTMENT_FORM: AdjustmentForm = {
  entryType: 'gift',
  quantity: '',
  manualDirection: 'increase',
  reason: '',
};

function createRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* restricted browser */ }
  return `ledger-adjustment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function adjustmentPayload(
  studentId: string,
  form: AdjustmentForm,
  clientRequestId: string,
): PrepareLessonLedgerAdjustmentRequest | null {
  const quantity = Number(form.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 2_147_483_647 || !form.reason.trim()) return null;
  const lessonDelta = form.entryType === 'refund'
    ? -quantity
    : form.entryType === 'manual_adjustment' && form.manualDirection === 'decrease'
      ? -quantity
      : quantity;
  return {
    studentId,
    entryType: form.entryType,
    lessonDelta,
    reason: form.reason.trim(),
    clientRequestId,
  };
}

function adjustmentFingerprint(studentId: string, form: AdjustmentForm): string {
  return JSON.stringify({ studentId, entryType: form.entryType, quantity: form.quantity, manualDirection: form.manualDirection, reason: form.reason.trim() });
}

function balanceTotal(balance: LessonBalance): number {
  return balance.remaining;
}

function StudentLedgerReadbackScoped({ teacherId, studentId, refreshToken, onLedgerChanged }: StudentLedgerReadbackProps) {
  const [balance, setBalance] = useState<LessonBalance | null>(null);
  const [entries, setEntries] = useState<LessonLedgerEntryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adjustment, setAdjustment] = useState<AdjustmentForm>(INITIAL_ADJUSTMENT_FORM);
  const [adjustmentError, setAdjustmentError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<PrepareLessonLedgerAdjustmentResult | null>(null);
  const [confirmationNotice, setConfirmationNotice] = useState('');
  const preparedRequest = useRef<{ fingerprint: string; body: PrepareLessonLedgerAdjustmentRequest } | null>(null);
  const adjustmentGeneration = useRef(0);
  const sequence = useRef(0);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; sequence.current += 1; };
  }, []);

  const reload = useCallback(async (options: { preserveVisibleData?: boolean; preservePendingAdjustment?: boolean } = {}) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    if (!options.preservePendingAdjustment) {
      // New authoritative data invalidates a local before/after proposal. It must be prepared again.
      adjustmentGeneration.current += 1;
      setPreview(null);
      preparedRequest.current = null;
      setPreparing(false);
      setAdjustmentError('');
    }
    if (!options.preserveVisibleData) {
      setBalance(null);
      setEntries([]);
    }
    try {
      const [nextBalance, nextEntries] = await Promise.all([
        getStudentBalance(teacherId, studentId),
        listLessonLedgerEntries(teacherId, { studentId }),
      ]);
      if (!live.current || request !== sequence.current) return false;
      setBalance(nextBalance);
      setEntries(nextEntries);
      return true;
    } catch (cause) {
      if (live.current && request === sequence.current) setError(messageOf(cause));
      return false;
    } finally {
      if (live.current && request === sequence.current) setLoading(false);
    }
  }, [teacherId, studentId]);

  const refreshConfirmedReadback = useCallback(async () => {
    const accountRefreshed = await reload({ preserveVisibleData: true, preservePendingAdjustment: true });
    let workspaceRefreshed = true;
    try {
      await onLedgerChanged?.();
    } catch {
      workspaceRefreshed = false;
    }
    return accountRefreshed && workspaceRefreshed;
  }, [onLedgerChanged, reload]);

  useEffect(() => { void reload(); }, [reload, refreshToken]);

  const updateAdjustment = (changes: Partial<AdjustmentForm>) => {
    setAdjustment((current) => ({ ...current, ...changes }));
    setAdjustmentError('');
    setConfirmationNotice('');
  };

  const prepare = async () => {
    const generation = ++adjustmentGeneration.current;
    const fingerprint = adjustmentFingerprint(studentId, adjustment);
    const known = preparedRequest.current;
    const clientRequestId = known?.fingerprint === fingerprint ? known.body.clientRequestId : createRequestId();
    const body = adjustmentPayload(studentId, adjustment, clientRequestId);
    if (!body) {
      setAdjustmentError('请选择调整类型，填写正整数课时和调整原因。');
      return;
    }
    // A transient failure is safely replayed with this exact payload and request key.
    preparedRequest.current = { fingerprint, body };
    setPreparing(true);
    setAdjustmentError('');
    try {
      const nextPreview = await prepareLessonLedgerAdjustment(teacherId, body);
      if (!live.current || generation !== adjustmentGeneration.current) return;
      if (nextPreview.confirmation.status === 'confirmed') {
        // The same idempotency key may be replayed after a confirmation response
        // was lost. Never present that completed operation as a new proposal.
        setBalance(nextPreview.balanceAfter);
        setPreview(null);
        setAdjustment(INITIAL_ADJUSTMENT_FORM);
        preparedRequest.current = null;
        setConfirmationNotice('该调整已经确认写入流水，正在更新账户读取结果。');
        const refreshed = await refreshConfirmedReadback();
        if (live.current && generation === adjustmentGeneration.current) {
          setConfirmationNotice(refreshed
            ? '该调整已经确认写入流水，余额和流水已从服务端更新。'
            : '该调整已经确认写入流水，但账户重新读取失败。请使用“刷新”查看最新流水。');
        }
        return;
      }
      setPreview(nextPreview);
    } catch (cause) {
      if (live.current && generation === adjustmentGeneration.current) setAdjustmentError(messageOf(cause));
    } finally {
      if (live.current && generation === adjustmentGeneration.current) setPreparing(false);
    }
  };

  const returnToEdit = () => {
    adjustmentGeneration.current += 1;
    setPreview(null);
    // A previous preview is no longer the operation to confirm. Deliberately start a new idempotency key.
    preparedRequest.current = null;
    setAdjustmentError('');
    setConfirmationNotice('');
  };

  const cancelAdjustment = () => {
    adjustmentGeneration.current += 1;
    setPreview(null);
    preparedRequest.current = null;
    setAdjustmentError('');
    setAdjustment(INITIAL_ADJUSTMENT_FORM);
    setConfirmationNotice('');
  };

  const confirm = async () => {
    if (!preview || confirming) return;
    setConfirming(true);
    setAdjustmentError('');
    try {
      const result = await confirmLessonLedgerAdjustment(teacherId, preview.confirmation.id);
      if (!live.current) return;
      // The confirmation response is authoritative. Refresh only after it has been applied locally.
      setBalance(result.balance);
      setPreview(null);
      setAdjustment(INITIAL_ADJUSTMENT_FORM);
      preparedRequest.current = null;
      setConfirmationNotice('已确认写入流水，正在更新账户读取结果。');
      const refreshed = await refreshConfirmedReadback();
      if (live.current) {
        setConfirmationNotice(refreshed
          ? '已确认写入流水，余额和流水已从服务端更新。'
          : '已确认写入流水，但账户重新读取失败。请使用“刷新”查看最新流水。');
      }
    } catch (cause) {
      if (live.current) setAdjustmentError(messageOf(cause));
    } finally {
      if (live.current) setConfirming(false);
    }
  };

  return (
    <section className="student-ledger-readback" aria-label="学生课时账户">
      <header className="student-ledger-heading">
        <div>
          <p className="student-ledger-eyebrow">课时账户</p>
          <h2>余额与流水</h2>
          <p className="student-ledger-caption">以不可变课时流水为准，时间均为北京时间</p>
        </div>
        <button className="button secondary small" type="button" onClick={() => void reload()} disabled={loading || preparing || confirming}>
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

      {confirmationNotice && <p className="student-ledger-confirmation-notice" role="status">{confirmationNotice}</p>}

      {!error && balance && (
        <>
          <dl className="student-ledger-balance" aria-label="课时余额汇总">
            <div><dt>已购课时</dt><dd>{balance.purchased}</dd></div>
            <div><dt>已消耗</dt><dd>{balance.attended}</dd></div>
            <div><dt>调整课时</dt><dd>{balance.adjustments > 0 ? `+${balance.adjustments}` : balance.adjustments}</dd></div>
            <div className="student-ledger-balance-total"><dt>当前剩余</dt><dd>{balance.remaining}<small>课时</small></dd></div>
          </dl>
          <section className="student-ledger-adjustment" aria-labelledby="student-ledger-adjustment-title">
            <div className="student-ledger-adjustment-heading">
              <div>
                <h3 id="student-ledger-adjustment-title">调整课时</h3>
                <p>先查看影响，再明确确认写入流水。</p>
              </div>
              {!preview && (
                <button className="button secondary small" type="button" onClick={cancelAdjustment} disabled={preparing || confirming}>
                  取消调整
                </button>
              )}
            </div>
            {!preview ? (
              <form className="student-ledger-adjustment-form" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
                <fieldset disabled={preparing || confirming}>
                  <legend>调整类型</legend>
                  <div className="student-ledger-choice-row">
                    <label><input type="radio" name="ledger-adjustment-type" checked={adjustment.entryType === 'gift'} onChange={() => updateAdjustment({ entryType: 'gift' })} />赠课</label>
                    <label><input type="radio" name="ledger-adjustment-type" checked={adjustment.entryType === 'refund'} onChange={() => updateAdjustment({ entryType: 'refund' })} />退款记录</label>
                    <label><input type="radio" name="ledger-adjustment-type" checked={adjustment.entryType === 'manual_adjustment'} onChange={() => updateAdjustment({ entryType: 'manual_adjustment' })} />人工调整</label>
                  </div>
                </fieldset>
                {adjustment.entryType === 'manual_adjustment' && (
                  <fieldset disabled={preparing || confirming}>
                    <legend>调整方向</legend>
                    <div className="student-ledger-choice-row">
                      <label><input type="radio" name="ledger-adjustment-direction" checked={adjustment.manualDirection === 'increase'} onChange={() => updateAdjustment({ manualDirection: 'increase' })} />增加课时</label>
                      <label><input type="radio" name="ledger-adjustment-direction" checked={adjustment.manualDirection === 'decrease'} onChange={() => updateAdjustment({ manualDirection: 'decrease' })} />扣减课时</label>
                    </div>
                  </fieldset>
                )}
                {adjustment.entryType === 'refund' && <p className="student-ledger-refund-note">仅用于对账记录，不代表平台已实际退款。</p>}
                <label>
                  课时数量
                  <input aria-label="课时数量" disabled={preparing || confirming} inputMode="numeric" max="2147483647" min="1" step="1" type="number" value={adjustment.quantity} onChange={(event) => updateAdjustment({ quantity: event.target.value })} />
                </label>
                <label>
                  调整原因
                  <textarea aria-label="调整原因" disabled={preparing || confirming} value={adjustment.reason} onChange={(event) => updateAdjustment({ reason: event.target.value })} rows={3} />
                </label>
                {adjustmentError && <p className="student-ledger-adjustment-error" role="alert">{adjustmentError}</p>}
                <button className="button primary" type="submit" disabled={preparing || confirming}>{confirming ? '正在更新账户…' : preparing ? '正在查看影响…' : '查看影响'}</button>
              </form>
            ) : (
              <div className="student-ledger-adjustment-preview" aria-live="polite">
                <h4>请确认本次课时调整</h4>
                <dl>
                  <div><dt>当前剩余</dt><dd>{balanceTotal(preview.balanceBefore)} 课时</dd></div>
                  <div><dt>本次变动</dt><dd>{formatDelta(preview.confirmation.lessonDelta)}</dd></div>
                  <div><dt>预计剩余</dt><dd>{balanceTotal(preview.balanceAfter)} 课时</dd></div>
                  <div><dt>调整原因</dt><dd>{preview.confirmation.reason}</dd></div>
                </dl>
                {preview.confirmation.entryType === 'refund' && <p className="student-ledger-refund-note">仅用于对账记录，不代表平台已实际退款。</p>}
                {adjustmentError && <p className="student-ledger-adjustment-error" role="alert">{adjustmentError}</p>}
                <div className="student-ledger-adjustment-actions">
                  <button className="button secondary" type="button" onClick={returnToEdit} disabled={confirming}>返回修改</button>
                  <button className="button primary" type="button" onClick={() => void confirm()} disabled={confirming}>{confirming ? '正在确认…' : '确认写入流水'}</button>
                </div>
              </div>
            )}
          </section>
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
