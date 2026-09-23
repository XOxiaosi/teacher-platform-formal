import { today as fallbackToday, type Schedule, type ScheduleRevision } from './data';
import { commitAction } from './action-result';
import { Confirm, type PreviewActions, studentName } from './PreviewApp';
import { ruleFor, scheduleConflict, schedulesInRange } from './recurrence';
import { EditScheduleForm, openScheduleEditor } from './ScheduleForm';
import { formatDate, formatDateTime } from '../shared/date-format';

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
  return <><dl className="schedule-detail"><div><dt>状态</dt><dd>{statusLabel(item.status)}</dd></div><div><dt>时间</dt><dd>{formatDate(item.day)} {item.start}–{item.end}</dd></div>{entryLabel && <div><dt>{entryLabel}</dt><dd>{formatDateTime(item.createdAt!)}（北京时间）</dd></div>}<div><dt>地点</dt><dd>{item.location || '待补充'}</dd></div><div><dt>{item.status === '已完成' ? '当前名单' : '参与人'}</dt><dd>{participantNames(actions, item)}</dd></div><div><dt>形式</dt><dd>{item.format}</dd></div><div><dt>备注</dt><dd>{item.note || '暂无备注'}</dd></div>{rule && <div><dt>重复规则</dt><dd>{rule.enabled ? `每周 ${rule.weekdays.map((day) => ['一', '二', '三', '四', '五', '六', '日'][day - 1]).join('、')} · ${rule.endDate ? `至 ${formatDate(rule.endDate)}` : '无结束日期'}` : '已暂停'}</dd></div>}{item.status === '已完成' && <div><dt>原扣课记录</dt><dd>{records.length ? records.map((record) => `${studentName(actions.data, record.studentId)}：${record.before} → ${record.after} 课时`).join('；') : '未找到原扣课记录'}</dd></div>}{item.status === '已完成' && revisionHistory(actions, revisions)}</dl>{canAct ? <div className="dialog-actions schedule-detail-actions"><button className="button secondary" onClick={() => rule ? scopeChooser(actions, item, 'edit') : openScheduleEditor(actions, item)}>编辑</button><button className="button secondary" onClick={() => rule ? scopeChooser(actions, item, 'cancel') : cancel(actions, item, 'this')}>取消</button><button className="button primary" onClick={() => complete(actions, item)}>完成并确认</button></div> : <><p className="dialog-copy">{item.status === '已完成' ? '已完成。编辑课程不会重新扣课，原扣课记录保留。' : '已取消：可恢复为待上课课程。'}</p>{item.status === '已完成' && <div className="dialog-actions"><button className="button secondary" onClick={() => openScheduleEditor(actions, item)}>编辑课程</button></div>}{item.status === '已取消' && <div className="dialog-actions"><button className="button primary" onClick={() => restore(actions, item)}>恢复排期</button></div>}</>}</>;
}

export function openScheduleDetails(actions: PreviewActions, item: Schedule): void {
  actions.open('排期详情', <ScheduleDetails actions={actions} item={item} />);
}
