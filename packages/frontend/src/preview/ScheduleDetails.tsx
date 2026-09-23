import { useState } from 'react';
import { today as fallbackToday, type LessonAttendance, type Schedule, type ScheduleRevision } from './data';
import { commitAction } from './action-result';
import { Confirm, type PreviewActions, studentName } from './PreviewApp';
import { ruleFor, scheduleConflict, schedulesInRange } from './recurrence';
import { EditScheduleForm, openScheduleEditor } from './ScheduleForm';
import { formatDate, formatDateTime } from '../shared/date-format';
import type { LessonStatusCorrectionPrepareResult } from '../contracts/lesson-status-correction';

function participantNames(actions: PreviewActions, item: Schedule) {
  return item.participants.map((id) => studentName(actions.data, id)).join('、') || '待补充参与人';
}

function statusLabel(status: Schedule['status']) {
  return status === '已排期' ? '待上课' : status;
}

function scheduleValues(actions: PreviewActions, item: Schedule) {
  return <>{formatDate(item.day)} {item.start}–{item.end}；地点：{item.location || '待补充'}；参与人：{participantNames(actions, item)}；形式：{item.format}；备注：{item.note || '暂无备注'}</>;
}

function shanghaiDay(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const take = (kind: string) => parts.find((part) => part.type === kind)?.value || '';
  return `${take('year')}-${take('month')}-${take('day')}`;
}

export function historicalEntryLabel(item: Schedule, businessDate: string): '补录时间' | '录入时间' | null {
  if (!item.createdAt || item.day >= businessDate) return null;
  return shanghaiDay(item.createdAt) && shanghaiDay(item.createdAt)! > item.day ? '补录时间' : '录入时间';
}

function revisionHistory(actions: PreviewActions, revisions: ScheduleRevision[]) {
  if (!revisions.length) return null;
  return <div><dt>修订记录</dt><dd><ol className="schedule-revisions">{revisions.map((revision) => <li key={revision.id}><b>{revisionTimeLabel(revision.changedAt)}</b><span>修订前：{scheduleValues(actions, revision.before)}</span><span>修订后：{scheduleValues(actions, revision.after)}</span></li>)}</ol></dd></div>;
}

export function revisionTimeLabel(value: string) {
  return formatDateTime(value);
}

export function recurrenceScopeStart(item: Schedule) {
  return item.recurrenceDay || item.day;
}

function complete(actions: PreviewActions, item: Schedule) {
  const changes = item.participants.map((id) => {
    const balance = actions.data.students.find((student) => student.id === id)?.balance ?? 0;
    return `${studentName(actions.data, id)}：${balance} → ${balance - 1} 课时`;
  }).join('；');
  actions.open('确认完成排期', <Confirm text={<>确认后每位参与人各扣 1 课时。<br />{changes}</>} onCancel={actions.close} onConfirm={() => commitAction(actions, () => actions.complete(item.id, item), () => { actions.close(); actions.toast('课程已完成'); })} label="确认完成" />);
}

const connectedCompletionUnavailable = '完课前需核对每位学生的实际出勤、拟扣课时和余额变化；当前暂不能确认完课。';

function cancel(actions: PreviewActions, item: Schedule, scope: 'this' | 'future') {
  const label = scope === 'future' ? '本次及以后' : '仅本次';
  actions.open('确认取消排期', <Confirm text={`取消范围：${label}。取消不扣课；已完成课程和已有扣课记录不会改动。`} onCancel={actions.close} onConfirm={() => {
    commitAction(actions, () => scope === 'future' && item.recurrenceRuleId ? actions.endRuleBefore?.(item.recurrenceRuleId, recurrenceScopeStart(item)) : actions.cancelSchedule(item.id, item), () => { actions.close(); actions.toast(scope === 'future' ? '已停止本次及以后的重复排期' : '本次排期已取消'); });
  }} label={`确认取消${label}`} />);
}

function restore(actions: PreviewActions, item: Schedule) {
  const restored: Schedule = { ...item, status: '已排期' };
  const hasConflict = () => scheduleConflict(schedulesInRange(actions.data, item.day, item.day), restored);
  if (hasConflict()) return actions.toast('恢复会与现有排期冲突，请先调整时间。', 'warn');
  actions.open('确认恢复排期', <Confirm text="恢复后课程会回到待上课状态，不会改动课时余额或已有扣课记录。" onCancel={actions.close} onConfirm={() => {
    if (hasConflict()) return actions.toast('恢复会与现有排期冲突，请先调整时间。', 'warn');
    commitAction(actions, () => actions.saveSchedule(restored), () => { actions.close(); actions.toast('排期已恢复'); });
  }} label="确认恢复" />);
}

function scopeChooser(actions: PreviewActions, item: Schedule, kind: 'edit' | 'cancel') {
  const verb = kind === 'edit' ? '修改' : '取消';
  actions.open(`${verb}重复排期`, <><p className="dialog-copy">请选择作用范围。默认只影响本次；批量影响需要明确确认。</p><div className="dialog-actions scope-actions"><button className="button secondary" onClick={() => kind === 'edit' ? openScheduleEditor(actions, item, 'this') : cancel(actions, item, 'this')}>仅本次</button><button className="button primary" onClick={() => kind === 'edit' ? openScheduleEditor(actions, item, 'future') : cancel(actions, item, 'future')}>本次及以后</button></div></>);
}

function proposedValues(actions: PreviewActions, item: Schedule) {
  return <>{formatDate(item.day)} {item.start}–{item.end}；地点：{item.location || '待补充'}；参与人：{participantNames(actions, item)}；形式：{item.format}</>;
}

function attendanceLabel(status: LessonAttendance['status']) {
  return status === 'attended' ? '已出勤' : status === 'absent' ? '缺席' : '待确认';
}

function CorrectionConfirmation({ actions, result }: { actions: PreviewActions; result: LessonStatusCorrectionPrepareResult }) {
  const { confirmation, balanceBefore, balanceAfter } = result;
  const name = studentName(actions.data, confirmation.studentId);
  const remainingDelta = balanceAfter.remaining - balanceBefore.remaining;
  const balanceExplanation = confirmation.toStatus === 'absent'
    ? '改为缺席后，本次不再计入已用课时，预计返还 1 课时。'
    : '改为已出勤后，本次计入 1 个已用课时，预计扣减 1 课时。';
  const confirm = () => {
    if (!actions.confirmLessonStatusCorrection) return;
    commitAction(actions, () => actions.confirmLessonStatusCorrection!(confirmation.id).then(() => undefined), () => {
      actions.close();
      actions.toast('出勤状态更正已保存');
    });
  };
  return <><p className="dialog-copy">请确认以下更正。当前只是预览，尚未生效。</p><dl className="schedule-detail correction-preview"><div><dt>学生</dt><dd>{name}</dd></div><div><dt>出勤状态</dt><dd>{attendanceLabel(confirmation.fromStatus)} → {attendanceLabel(confirmation.toStatus)}</dd></div><div><dt>课时余额</dt><dd>{balanceBefore.remaining} → {balanceAfter.remaining}（{remainingDelta > 0 ? '+' : ''}{remainingDelta}）</dd></div><div><dt>余额说明</dt><dd>{balanceExplanation}</dd></div><div><dt>更正原因</dt><dd>{confirmation.reason}</dd></div></dl><p className="dialog-copy">确认后会保留本次更正记录，并按上述影响保存余额变化。</p><div className="dialog-actions"><button className="button secondary" onClick={actions.close}>取消</button><button className="button primary" onClick={confirm}>确认更正</button></div></>;
}

function CorrectionForm({ actions, item, attendance }: { actions: PreviewActions; item: Schedule; attendance: LessonAttendance }) {
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const targetStatus = attendance.status === 'attended' ? 'absent' : 'attended';
  const prepare = () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    if (!actions.prepareLessonStatusCorrection) return;
    void actions.prepareLessonStatusCorrection({ lessonId: attendance.lessonId, targetStatus, reason: trimmed, clientRequestId: requestId }).then((result) => {
      actions.open('确认出勤状态更正', <CorrectionConfirmation actions={actions} result={result} />);
    }).catch((error: unknown) => actions.toast(error instanceof Error ? error.message : '预览未生成，请重试。', 'warn'));
  };
  return <><p className="dialog-copy">{studentName(actions.data, attendance.studentId)}：{attendanceLabel(attendance.status)} → {attendanceLabel(targetStatus)}</p><label className="field-label" htmlFor={`correction-reason-${item.id}-${attendance.lessonId}`}>更正原因（必填）</label><textarea id={`correction-reason-${item.id}-${attendance.lessonId}`} className="text-input" rows={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：课后核对签到记录后发现状态录入错误" required /><div className="dialog-actions"><button className="button secondary" onClick={actions.close}>取消</button><button className="button primary" disabled={!reason.trim()} onClick={prepare}>查看影响预览</button></div></>;
}

function openCorrection(actions: PreviewActions, item: Schedule, attendance: LessonAttendance) {
  if (!actions.connected || !actions.prepareLessonStatusCorrection || !actions.confirmLessonStatusCorrection) return;
  actions.open('更正出勤状态', <CorrectionForm actions={actions} item={item} attendance={attendance} />);
}

function openProposalEditor(actions: PreviewActions, item: Schedule, proposal: Schedule, scope: 'this' | 'future') {
  const title = scope === 'future' ? '调整本次及以后重复排期' : item.status === '已完成' ? '调整已完成课程' : '调整本次排期';
  actions.open(title, <><p className="dialog-copy">拖动调整尚未保存。请核对原时间和新时间；可继续通过原生日期、时间输入框微调。</p><dl className="schedule-detail schedule-reschedule-proposal"><div><dt>原时间</dt><dd>{proposedValues(actions, item)}</dd></div><div><dt>新时间</dt><dd>{proposedValues(actions, proposal)}</dd></div><div><dt>作用范围</dt><dd>{item.status === '已完成' || scope === 'this' ? '仅本次' : '本次及以后'}</dd></div></dl><EditScheduleForm actions={actions} schedule={item} scope={scope} draft={proposal} /></>);
}

/** Opens the same local draft and explicit save chain used by detail editing. */
export function openScheduleRescheduleProposal(actions: PreviewActions, item: Schedule, proposal: Schedule) {
  if (item.status === '已取消') return actions.toast('已取消课程不可拖动调整；请先恢复排期。', 'warn');
  const rule = ruleFor(actions.data, item);
  if (!rule || item.status === '已完成') return openProposalEditor(actions, item, proposal, 'this');
  actions.open('调整重复排期', <><p className="dialog-copy">拖动调整尚未保存。重复课程请选择作用范围；默认仅影响本次。</p><dl className="schedule-detail schedule-reschedule-proposal"><div><dt>原时间</dt><dd>{proposedValues(actions, item)}</dd></div><div><dt>新时间</dt><dd>{proposedValues(actions, proposal)}</dd></div></dl><div className="dialog-actions scope-actions"><button className="button secondary" onClick={() => openProposalEditor(actions, item, proposal, 'this')}>仅本次</button><button className="button primary" onClick={() => openProposalEditor(actions, item, proposal, 'future')}>本次及以后</button></div></>);
}

export function ScheduleDetails({ actions, item }: { actions: PreviewActions; item: Schedule }) {
  const rule = ruleFor(actions.data, item);
  const canAct = item.status === '已排期';
  const entryLabel = historicalEntryLabel(item, actions.data.businessDate || fallbackToday);
  const records = actions.data.completionRecords.filter((record) => record.scheduleId === item.id);
  const revisions = (actions.data.scheduleRevisions || []).filter((entry) => entry.scheduleId === item.id);
  // Lessons are the attendance source of truth. A completed schedule's current
  // participant list may have been edited later, so do not hide an original
  // participant's correction record merely because they left that list.
  const attendance = item.attendance?.filter((entry) => entry.status === 'attended' || entry.status === 'absent') || [];
  return <><dl className="schedule-detail"><div><dt>状态</dt><dd>{statusLabel(item.status)}</dd></div><div><dt>时间</dt><dd>{formatDate(item.day)} {item.start}–{item.end}</dd></div>{entryLabel && <div><dt>{entryLabel}</dt><dd>{formatDateTime(item.createdAt!)}（北京时间）</dd></div>}<div><dt>地点</dt><dd>{item.location || '待补充'}</dd></div><div><dt>{item.status === '已完成' ? '当前名单' : '参与人'}</dt><dd>{participantNames(actions, item)}</dd></div><div><dt>形式</dt><dd>{item.format}</dd></div><div><dt>备注</dt><dd>{item.note || '暂无备注'}</dd></div>{rule && <div><dt>重复规则</dt><dd>{rule.enabled ? `每周 ${rule.weekdays.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')} · ${rule.endDate ? `至 ${formatDate(rule.endDate)}` : '无结束日期'}` : '已暂停'}</dd></div>}{item.status === '已完成' && <div><dt>原扣课记录</dt><dd>{records.length ? records.map((record) => `${studentName(actions.data, record.studentId)}：${record.before} → ${record.after} 课时`).join('；') : '未找到原扣课记录'}</dd></div>}{item.status === '已完成' && revisionHistory(actions, revisions)}</dl>{item.status === '已完成' && attendance.length > 0 && <section className="schedule-attendance" aria-label="本次出勤状态"><h3>本次出勤状态</h3>{attendance.map((entry) => { const name = studentName(actions.data, entry.studentId); return <div className="schedule-attendance-row" key={entry.lessonId}><span>{name}</span><span>{attendanceLabel(entry.status)}</span>{actions.connected && actions.prepareLessonStatusCorrection && actions.confirmLessonStatusCorrection && <button className="button secondary small" aria-label={`更正${name}的出勤状态`} onClick={() => openCorrection(actions, item, entry)}>更正</button>}</div>; })}</section>}{canAct ? <div className="dialog-actions schedule-detail-actions"><button className="button secondary" onClick={() => rule ? scopeChooser(actions, item, 'edit') : openScheduleEditor(actions, item)}>编辑</button><button className="button secondary" onClick={() => rule ? scopeChooser(actions, item, 'cancel') : cancel(actions, item, 'this')}>取消</button>{actions.connected ? <p className="dialog-copy" role="note">{connectedCompletionUnavailable}</p> : <button className="button primary" onClick={() => complete(actions, item)}>完成并确认</button>}</div> : <><p className="dialog-copy">{item.status === '已完成' ? '已完成。编辑课程不会重新扣课，原扣课记录保留。' : '已取消：可恢复为待上课课程。'}</p>{item.status === '已完成' && <div className="dialog-actions"><button className="button secondary" onClick={() => openScheduleEditor(actions, item)}>编辑课程</button></div>}{item.status === '已取消' && <div className="dialog-actions"><button className="button primary" onClick={() => restore(actions, item)}>恢复排期</button></div>}</>}</>;
}

export function openScheduleDetails(actions: PreviewActions, item: Schedule): void {
  actions.open('排期详情', <ScheduleDetails actions={actions} item={item} />);
}
