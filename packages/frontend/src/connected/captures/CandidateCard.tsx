import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { confirmCaptureCandidate, editCaptureCandidate, reviewCaptureCandidate, type CaptureCandidate, type CaptureRecord, type CaptureProjectionVisibility, type CaptureVisibility } from '../../api/captures';
import { readCaptureDraft, subscribeCaptureDraft, writeCaptureDraft, type CaptureDraft } from './drafts';

export type CaptureStudent = { id: string; name: string; grade: string };
type TrustedConfirmationReceipt = {
  id: string;
  studentId: string;
  reviewStatus: 'confirmed';
  visibility: CaptureVisibility;
};
const trustedConfirmationReceipts = new Map<string, { generation: string; receipt: TrustedConfirmationReceipt }>();
const labels = { pending: '待核对', deferred: '暂留', rejected: '已拒绝', confirmed: '已保存' };
export function CandidateCard({ teacherId, item, captureId, students, onChange }: {
  teacherId: string; item: CaptureCandidate; captureId: string; students: CaptureStudent[]; onChange: () => Promise<void>;
}) {
  const [currentState, setCurrent] = useState(item);
  // Candidate operations use currentState for immediate response rendering;
  // formal ownership always comes directly from the latest server prop.
  const current = currentState;
  const projection = item.confirmedRecord;
  const receiptKey = `${teacherId}\u0000${captureId}\u0000${item.id}`;
  const [draft, setDraft] = useState<CaptureDraft>(() => readCaptureDraft(teacherId, captureId, item.id) ?? {
    generation: crypto.randomUUID(), text: item.payload.text, studentId: '', baseVersion: item.version ?? 1, visibility: item.visibility ?? 'internal_only',
  });
  const [confirmedReceipt, setConfirmedReceipt] = useState<TrustedConfirmationReceipt | null>(() => readTrustedReceipt(receiptKey, draft));
  const draftRef = useRef(draft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeCaptureDraft(teacherId, captureId, item.id, next => {
      draftRef.current = next;
      setDraft(next);
      setConfirmedReceipt(readTrustedReceipt(receiptKey, next));
    });
    writeCaptureDraft(teacherId, captureId, item.id, draftRef.current);
    return () => { alive.current = false; unsubscribe(); };
  }, [teacherId, captureId, item.id, receiptKey]);
  useEffect(() => {
    setCurrent(previous => item.id !== previous.id || (item.version ?? 1) > (previous.version ?? 1) ? item : previous);
    if (item.confirmedRecord != null || item.reviewStatus === 'confirmed' || item.reviewStatus === 'rejected' || !!item.confirmedRecordId) {
      trustedConfirmationReceipts.delete(receiptKey);
      setConfirmedReceipt(null);
    }
  }, [item, receiptKey]);
  const changedVersion = draft.baseVersion !== (current.version ?? 1);
  const displayReviewStatus = item.reviewStatus === 'confirmed' || item.reviewStatus === 'rejected' ? item.reviewStatus : current.reviewStatus;
  const serverSettled = item.reviewStatus === 'confirmed' || item.reviewStatus === 'rejected'
    || (projection !== undefined && projection !== null) || !!item.confirmedRecordId;
  const serverAhead = !!draft.pendingConfirm && (item.version ?? 1) > draft.pendingConfirm.version;
  const confirmationBlocked = serverSettled || serverAhead;
  const uncertain = !!draft.pendingConfirm && !confirmationBlocked;
  const effectiveRecord = projection ?? (!serverSettled ? confirmedReceipt : null);
  const projectionRecordId = effectiveRecord?.id ?? (projection === null ? item.confirmedRecordId : undefined);
  const saved = item.reviewStatus === 'confirmed' || !!item.confirmedRecordId || !!effectiveRecord;
  const projectionUnavailable = (projection === null && (!!item.confirmedRecordId || item.reviewStatus === 'confirmed'))
    || (serverSettled && projection === undefined && (!!item.confirmedRecordId || item.reviewStatus === 'confirmed'));
  const confirmedStudentId = effectiveRecord?.studentId;
  const confirmedVisibility: CaptureProjectionVisibility | undefined = effectiveRecord?.visibility;
  const confirmedReviewStatus = effectiveRecord?.reviewStatus;
  const locked = saved || current.reviewStatus === 'confirmed' || current.reviewStatus === 'rejected'
    || item.reviewStatus === 'confirmed' || item.reviewStatus === 'rejected' || serverAhead;
  function saveDraft(next: CaptureDraft) {
    draftRef.current = next;
    writeCaptureDraft(teacherId, captureId, item.id, next);
    if (alive.current) setDraft(next);
  }
  useEffect(() => {
    // A server projection is authoritative once present. Converge the browser
    // draft so a later remount does not resurrect an older pending confirmation.
    if (item.confirmedRecord === undefined) return;
    const latest = readCaptureDraft(teacherId, captureId, item.id);
    if (!latest) return;
    if (item.confirmedRecord) {
      const visibility = item.confirmedRecord.visibility === 'internal_only' || item.confirmedRecord.visibility === 'parent_shareable'
        ? item.confirmedRecord.visibility : undefined;
      if (latest.confirmedRecordId === item.confirmedRecord.id && latest.studentId === item.confirmedRecord.studentId
        && latest.visibility === visibility && latest.pendingConfirm === undefined) return;
      saveDraft({ ...latest, confirmedRecordId: item.confirmedRecord.id, studentId: item.confirmedRecord.studentId, visibility, pendingConfirm: undefined });
    } else if (item.confirmedRecordId && (latest.confirmedRecordId !== item.confirmedRecordId || latest.studentId || latest.visibility || latest.pendingConfirm)) {
      saveDraft({ ...latest, confirmedRecordId: item.confirmedRecordId, studentId: '', visibility: undefined, pendingConfirm: undefined });
    }
  }, [item.confirmedRecord, item.confirmedRecordId, teacherId, captureId, item.id]);
  useEffect(() => {
    if (!confirmationBlocked || !draft.pendingConfirm) return;
    const latest = readCaptureDraft(teacherId, captureId, item.id);
    if (latest?.pendingConfirm) saveDraft({ ...latest, pendingConfirm: undefined });
  }, [confirmationBlocked, draft.pendingConfirm, teacherId, captureId, item.id]);
  // A logout or a replacement draft invalidates late writes from old requests.
  function ownsDraft() {
    return readCaptureDraft(teacherId, captureId, item.id)?.generation === draftRef.current.generation;
  }
  function applyCandidate(result: CaptureRecord) {
    const updated = (result.candidates ?? [result.candidate]).find(candidate => candidate.id === item.id);
    if (!updated || !ownsDraft()) return;
    const latest = readCaptureDraft(teacherId, captureId, item.id)!;
    if (latest.baseVersion <= (updated.version ?? 1)) saveDraft({ ...latest, baseVersion: updated.version ?? 1 });
    if (alive.current) setCurrent(updated);
  }
  async function run(work: () => Promise<void>) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try {
      await work();
      if (alive.current) {
        try { await onChange(); }
        catch { if (alive.current) setError('操作已保存，最新材料加载失败。请刷新材料核对结果。'); }
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '保存失败，请重试');
    } finally { active.current = false; if (alive.current) setBusy(false); }
  }
  async function confirm() {
    if (active.current || (locked && (confirmationBlocked || !draftRef.current.pendingConfirm))) return;
    const wasUncertain = !!draftRef.current.pendingConfirm;
    const pending = draftRef.current.pendingConfirm ?? { clientRequestId: crypto.randomUUID(), studentId: draftRef.current.studentId, version: draftRef.current.baseVersion, visibility: draftRef.current.visibility ?? 'internal_only' };
    const attemptGeneration = crypto.randomUUID();
    saveDraft({ ...draftRef.current, generation: attemptGeneration, pendingConfirm: pending });
    await run(async () => {
      let result;
      try { result = await confirmCaptureCandidate(captureId, item.id, pending); }
      catch (failure) {
        const rejected = failure instanceof ApiError && (
          (failure.status === 400 && failure.error.code === 'VALIDATION_ERROR')
          || (failure.status === 404 && failure.error.code === 'NOT_FOUND')
          || (failure.status === 409 && ['VERSION_CONFLICT', 'ALREADY_CONSUMED'].includes(failure.error.code))
        );
        const latest = readCaptureDraft(teacherId, captureId, item.id);
        // Only a first-attempt rejection proves no write happened. A response
        // arriving after another mounted card retried must not unlock its input.
        if (!wasUncertain && rejected && latest?.generation === attemptGeneration
          && latest.pendingConfirm?.clientRequestId === pending.clientRequestId) {
          saveDraft({ ...latest, pendingConfirm: undefined });
        }
        throw failure;
      }
      if (!result?.recordId || result.studentId !== pending.studentId || !isCaptureVisibility(result.visibility) || result.visibility !== pending.visibility) throw new Error('尚未取得与本次确认匹配的保存回执，请重试核对。');
      const latest = readCaptureDraft(teacherId, captureId, item.id);
      if (latest?.generation === attemptGeneration && latest.pendingConfirm?.clientRequestId === pending.clientRequestId) {
        const receipt: TrustedConfirmationReceipt = {
          id: result.recordId,
          studentId: result.studentId,
          reviewStatus: 'confirmed',
          visibility: result.visibility,
        };
        trustedConfirmationReceipts.set(receiptKey, { generation: attemptGeneration, receipt });
        saveDraft({ ...latest, pendingConfirm: undefined, confirmedRecordId: result.recordId, visibility: result.visibility });
        if (alive.current) setConfirmedReceipt(receipt);
      }
    });
  }
  function acceptCurrentVersion() {
    // An older confirmation cannot commit against this newer, still-unconfirmed
    // version. The teacher explicitly reviews the new candidate before rebasing.
    saveDraft({ ...draftRef.current, baseVersion: current.version ?? 1, pendingConfirm: undefined });
    setError('');
  }
  return <article className="capture-candidate" aria-label={`候选：${current.payload.text}`}>
    <p><strong>{saved ? '已保存' : labels[displayReviewStatus]}</strong></p>
    {current.originalPayload && current.originalPayload.text !== draft.text && <details><summary>最初候选内容</summary><p className="capture-raw">{current.originalPayload.text}</p></details>}
    {((changedVersion && !locked) || (locked && draft.text !== current.payload.text)) && <section aria-label="候选变化" role="status">
      <p>{locked ? '候选已处理；保留的输入尚未保存。' : '候选已有更新，你的输入仍然保留。请先核对最新内容。'}</p><p className="capture-raw">最新候选：{current.payload.text}</p>
      {!locked && <button className="button secondary" disabled={busy} onClick={acceptCurrentVersion}>保留输入，按最新版本重新核对</button>}
    </section>}
    <label>{locked && draft.text !== current.payload.text ? '保留的未保存输入' : '拟保存内容'}<textarea value={draft.text} disabled={busy || locked || uncertain} onChange={(event) => saveDraft({ ...draftRef.current, text: event.target.value })} /></label>
    {(!locked || uncertain) && <>
      <label>归入学生<select value={draft.studentId} disabled={busy || uncertain} onChange={(event) => saveDraft({ ...draftRef.current, studentId: event.target.value })}>
        <option value="">请选择学生</option>{students.map((student, index) => <option key={student.id} value={student.id}>{student.name} · {student.grade || '年级待补充'}{students.filter(other => other.name === student.name && other.grade === student.grade).length > 1 ? ` · 档案 ${index + 1}` : ''}</option>)}
      </select></label>
      <label>分享范围<select aria-label="分享范围" value={draft.visibility ?? 'internal_only'} disabled={busy || uncertain} onChange={(event) => saveDraft({ ...draftRef.current, visibility: event.target.value as CaptureVisibility })}>
        <option value="internal_only">仅教师可见</option>
        <option value="parent_shareable">允许用于家长表达</option>
      </select></label>
      <p>{(draft.visibility ?? 'internal_only') === 'parent_shareable' ? '确认后可基于这条记录整理家长反馈。' : '默认仅教师可见；如需用于家长反馈，请选择“允许用于家长表达”。'}</p>
      <p>确认后将此项归入所选学生档案；其他候选仍需分别核对。</p>
      {uncertain && <p role="status">尚未取得保存回执，请重试本次确认或刷新材料核对结果。</p>}
      <div className="button-row">
        <button className="button secondary" disabled={busy || uncertain || changedVersion || !draft.text.trim() || draft.text === current.payload.text} onClick={() => void run(async () => applyCandidate(await editCaptureCandidate(captureId, item.id, { version: draftRef.current.baseVersion, text: draftRef.current.text })))}>保存候选修改</button>
        <button className="button primary" disabled={busy || (!uncertain && (changedVersion || !students.some(student => student.id === draft.studentId) || draft.text !== current.payload.text))} onClick={() => void confirm()}>{uncertain ? '重试本次确认' : '确认归入档案'}</button>
        <button className="button secondary" disabled={busy || uncertain || changedVersion || draft.text !== current.payload.text} onClick={() => void run(async () => applyCandidate(await reviewCaptureCandidate(captureId, item.id, { version: draftRef.current.baseVersion, action: 'defer' })))}>暂留</button>
        <button className="button secondary" disabled={busy || uncertain || changedVersion || draft.text !== current.payload.text} onClick={() => void run(async () => applyCandidate(await reviewCaptureCandidate(captureId, item.id, { version: draftRef.current.baseVersion, action: 'reject' })))}>拒绝</button>
      </div>
    </>}
    {projectionUnavailable && <p role="status">正式记录当前不可读取，学生归属和分享范围暂不可确认。</p>}
    {saved && !projectionUnavailable && confirmedStudentId && <p>已归入：{studentLabel(confirmedStudentId, students)}；分享范围：{visibilityLabel(confirmedVisibility)}。</p>}
    {saved && !projectionUnavailable && confirmedReviewStatus === 'confirmed' && confirmedVisibility === 'parent_shareable' && confirmedStudentId && projectionRecordId && <p className="button-row">
      <a className="button secondary" href={`#/feedback?studentId=${encodeURIComponent(confirmedStudentId)}&recordId=${encodeURIComponent(projectionRecordId)}`}>
        基于这条记录整理家长反馈
      </a>
    </p>}
    {saved && !projectionUnavailable && confirmedVisibility === 'internal_only' && <p>这条记录当前仅教师可见；如需整理家长反馈，请到学生档案调整分享范围。</p>}
    {saved && !projectionUnavailable && confirmedVisibility === 'needs_review' && <p>正式记录当前需要重新核对，暂不可用于家长反馈。</p>}
    {saved && !projectionUnavailable && (confirmedReviewStatus === 'rejected' || confirmedReviewStatus === 'superseded') && <p>正式记录当前不可用于家长反馈（{confirmedReviewStatus === 'rejected' ? '已拒绝' : '已被替代'}）。</p>}
    <p className="assistant-hint">未保存的核对输入暂存在当前浏览器会话中，退出账号后清除。</p>
    {error && <p role="alert">{error}</p>}
  </article>;
}

function studentLabel(studentId: string, students: CaptureStudent[]): string {
  const student = students.find(value => value.id === studentId);
  return student ? `${student.name} · ${student.grade || '年级待补充'}` : '当前学生档案不可读取';
}

function visibilityLabel(value: CaptureProjectionVisibility | undefined): string {
  if (value === 'parent_shareable') return '允许用于家长表达';
  if (value === 'needs_review') return '需要重新核对';
  return '仅教师可见';
}

function isCaptureVisibility(value: unknown): value is CaptureVisibility {
  return value === 'internal_only' || value === 'parent_shareable';
}

function readTrustedReceipt(key: string, draft: CaptureDraft): TrustedConfirmationReceipt | null {
  const stored = trustedConfirmationReceipts.get(key);
  return stored?.generation === draft.generation ? stored.receipt : null;
}
