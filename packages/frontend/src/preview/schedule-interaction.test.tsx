import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoData, today, type DemoData, type Schedule } from './data';
import type { PreviewActions } from './PreviewApp';
import { dateAdd, scheduleConflict } from './recurrence';
import { dateRangeLabel, scheduleDropProposal, SchedulesPage } from './SchedulePage';
import { openScheduleRescheduleProposal, ScheduleDetails } from './ScheduleDetails';
import { EditScheduleForm, NewScheduleForm } from './ScheduleForm';

function setup(data: DemoData = createDemoData()) {
  let opened: ReactNode = null;
  const open = vi.fn((_title: string, body: ReactNode) => { opened = body; });
  const actions: PreviewActions = {
    data, setData: vi.fn(), ui: {}, setUi: vi.fn(), open, toast: vi.fn(), close: vi.fn(),
    complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), editCompletedSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), endRuleBefore: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(),
  };
  return { actions, dialog: () => render(<>{opened}</>) };
}

function dragTransfer() {
  return { effectAllowed: '', dropEffect: '', setData: vi.fn() } as unknown as DataTransfer;
}

function dispatchDrag(node: Element, type: 'dragstart' | 'dragover' | 'drop' | 'dragend', transfer: DataTransfer, clientY?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(node, event);
}

describe('日程交互修复', () => {
  it('周历拖动按 15 分钟生成跨日提案并保持原时长，禁止跨午夜', () => {
    const data = createDemoData();
    const item = { ...data.schedules[1], start: '09:00', end: '10:30' };
    expect(scheduleDropProposal(item, '2026-09-25', 153, 0, 8)).toEqual(expect.objectContaining({
      day: '2026-09-25', start: '10:15', end: '11:45',
    }));
    expect(scheduleDropProposal({ ...item, start: '23:00', end: '24:00' }, '2026-09-25', 1054, 0, 8)).toBeNull();
  });

  it('真实周历拖放只打开本地提案，不改原数据；随后 click 不会覆盖提案', () => {
    const data = createDemoData();
    const item = { ...data.schedules[1], day: '2026-09-22', start: '14:00', end: '15:30' };
    const { actions } = setup({ ...data, businessDate: '2026-09-22', schedules: [item], recurrenceRules: [] });
    actions.ui = { 'schedule.view': 'week' };
    const original = JSON.parse(JSON.stringify(actions.data.schedules));
    const { container } = render(<SchedulesPage actions={actions} />);
    const source = screen.getByRole('button', { name: /查看 14:00 至 15:30/ });
    const target = container.querySelectorAll<HTMLElement>('.week-column')[2];
    for (const column of container.querySelectorAll<HTMLElement>('.week-column')) Object.defineProperty(column, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0 }) });
    const transfer = dragTransfer();
    dispatchDrag(source, 'dragstart', transfer);
    dispatchDrag(target, 'dragover', transfer, 153);
    expect(target).toHaveClass('is-drop-target');
    dispatchDrag(target, 'drop', transfer, 153);
    dispatchDrag(source, 'dragend', transfer);
    expect(actions.open).toHaveBeenCalledTimes(1);
    expect(actions.open).toHaveBeenCalledWith('调整本次排期', expect.anything());
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    expect(actions.data.schedules).toEqual(original);
    fireEvent.click(source);
    expect(actions.open).toHaveBeenCalledTimes(1);
  });

  it('真实周历拖放遇到冲突或拖回原位时零写入且保留原安排', () => {
    const data = createDemoData();
    const item = { ...data.schedules[1], day: '2026-09-22', start: '14:00', end: '15:30' };
    const collisions = Array.from({ length: 30 }, (_, index) => ({ ...data.schedules[2], id: `collision-${index}`, day: `2026-09-${String(1 + index).padStart(2, '0')}`, start: '00:00', end: '24:00' }));
    const { actions } = setup({ ...data, businessDate: '2026-09-22', schedules: [item, ...collisions], recurrenceRules: [] });
    expect(scheduleConflict(actions.data.schedules, { ...item, day: '2026-09-23', start: '10:15', end: '11:45' })).toBe(true);
    actions.ui = { 'schedule.view': 'week' };
    const { container } = render(<SchedulesPage actions={actions} />);
    const source = screen.getByRole('button', { name: /查看 14:00 至 15:30/ });
    const columns = container.querySelectorAll<HTMLElement>('.week-column');
    for (const column of columns) Object.defineProperty(column, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0 }) });
    const transfer = dragTransfer();
    dispatchDrag(source, 'dragstart', transfer);
    dispatchDrag(columns[2], 'dragover', transfer, 153);
    dispatchDrag(columns[2], 'drop', transfer, 153);
    expect(actions.open).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith('目标时段与现有排期冲突，原安排未改变。', 'warn');
    dispatchDrag(source, 'dragstart', transfer);
    dispatchDrag(source.closest('.week-column')!, 'drop', transfer, Number(source.style.top.replace('px', '')));
    expect(actions.toast).toHaveBeenCalledWith('位置未改变，未保存任何修改。');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    expect(actions.data.schedules[0]).toEqual(item);
  });

  it('拖动只打开原值、新值和确认链路，取消时不写入', () => {
    const data = createDemoData();
    const item = data.schedules[1];
    const proposal = { ...item, day: '2026-09-25', start: '10:15', end: '11:45' };
    const { actions, dialog } = setup({ ...data, schedules: [item], recurrenceRules: [] });
    openScheduleRescheduleProposal(actions, item, proposal);
    dialog();
    expect(screen.getByText('拖动调整尚未保存。请核对原时间和新时间；可继续通过原生日期、时间输入框微调。')).toBeInTheDocument();
    expect(screen.getByText('原时间').parentElement).toHaveTextContent(`${item.start}–${item.end}`);
    expect(screen.getByText('新时间').parentElement).toHaveTextContent('10:15–11:45');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    expect(actions.complete).not.toHaveBeenCalled();
  });

  it('重复课程拖动先要求作用范围，已取消课程不生成提案', () => {
    const data = createDemoData();
    const rule = data.recurrenceRules[0];
    const repeated: Schedule = { ...data.schedules[1], id: `${rule.id}@${rule.startDate}`, day: rule.startDate, recurrenceRuleId: rule.id, recurrenceDay: rule.startDate, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note };
    const { actions, dialog } = setup(data);
    openScheduleRescheduleProposal(actions, repeated, { ...repeated, start: '17:00', end: '18:30' });
    dialog();
    expect(screen.getByRole('button', { name: '仅本次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次及以后' })).toBeInTheDocument();
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    openScheduleRescheduleProposal(actions, { ...repeated, status: '已取消' }, repeated);
    expect(actions.toast).toHaveBeenCalledWith('已取消课程不可拖动调整；请先恢复排期。', 'warn');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
  });

  it('已完成课程拖动只能走本次修订，并保留原扣课边界', () => {
    const data = createDemoData();
    const completed = data.schedules[0];
    const { actions, dialog } = setup({ ...data, schedules: [completed], recurrenceRules: [] });
    openScheduleRescheduleProposal(actions, completed, { ...completed, day: '2026-09-25', start: '11:00', end: '12:30' });
    dialog();
    expect(screen.getByText('作用范围').parentElement).toHaveTextContent('仅本次');
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    expect(screen.getByText('确认后不会重新扣课；原扣课记录保留。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    expect(actions.editCompletedSchedule).toHaveBeenCalledWith(
      completed,
      expect.objectContaining({ day: '2026-09-25', start: '11:00', end: '12:30', status: '已完成' }),
    );
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    expect(actions.complete).not.toHaveBeenCalled();
  });

  it('跨月和跨年周历标题显示完整终点日期', () => {
    expect(dateRangeLabel('2026-09-28', '2026-10-04')).toBe('2026年9月28日—10月4日');
    expect(dateRangeLabel('2026-12-28', '2027-01-03')).toBe('2026年12月28日—2027年1月3日');
  });

  it('新建课程带入当前周首日，并按形式提供单选或多选参与人', () => {
    const { actions } = setup();
    render(<NewScheduleForm actions={actions} initialDay="2026-09-28" initialStudentId="s2" />);
    expect(screen.getByLabelText('日期')).toHaveValue('2026-09-28');
    const single = screen.getByLabelText('参与人') as HTMLSelectElement;
    expect(single).not.toHaveAttribute('multiple');
    expect(single).toHaveValue('s2');
    fireEvent.change(screen.getByLabelText('形式'), { target: { value: '小班' } });
    expect(screen.getByRole('group', { name: '参与人（至少选择 2 位）' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '王浩然' })).toBeChecked();
  });

  it('选用已有课程必须先选择来源，切回全新课程会恢复独立草稿', () => {
    const data = createDemoData();
    const source = { ...data.schedules[0], id: 'source', start: '14:00', end: '16:00', location: '来源地点', participants: ['s2'], note: '来源备注' };
    const { actions } = setup({ ...data, schedules: [source], recurrenceRules: [] });
    render(<NewScheduleForm actions={actions} initialDay="2026-09-28" initialStudentId="s1" />);
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '新建地点' } });
    fireEvent.click(screen.getByLabelText('每周重复'));
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    expect(screen.getByLabelText('仅一次')).toBeChecked();
    expect(screen.getByLabelText('每周重复')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先选择要预填的已有课程。');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('已有课程'), { target: { value: source.id } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('地点')).toHaveValue('来源地点');
    fireEvent.click(screen.getByLabelText('创建全新课程'));
    expect(screen.getByLabelText('地点')).toHaveValue('新建地点');
    expect(screen.getByLabelText('日期')).toHaveValue('2026-09-28');
    expect(screen.getByLabelText('参与人')).toHaveValue('s1');
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先选择要预填的已有课程。');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
  });

  it('历史新排期明确显示北京时间的日期与实际上课时段，且只保存不自动扣课', () => {
    const data = createDemoData();
    const { actions } = setup({ ...data, businessDate: '2026-09-10', schedules: [], recurrenceRules: [] });
    render(<NewScheduleForm actions={actions} initialDay="2026-09-09" initialStudentId="s1" />);
    expect(screen.getByRole('note')).toHaveTextContent('历史日期：2026年9月9日 10:00–12:00（北京时间），仅保存，不自动完课或扣课。');
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '补录地点' } });
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }));
    expect(actions.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-09-09', start: '10:00', end: '12:00', location: '补录地点', status: '已排期' }));
    expect(actions.complete).not.toHaveBeenCalled();
    expect(actions.addPayment).not.toHaveBeenCalled();
  });

  it('重复课程从原发生日向后拖动时替换该星期，确认页说明中间不自动排课并以原发生日切分', () => {
    const originalDay = '2026-10-05';
    const targetDay = '2026-10-07';
    const rule = { id: 'rr-move', startDate: originalDay, weekdays: [1, 5], enabled: true, start: '16:30', end: '18:00', location: '工作室 B', participants: ['s2', 's3'], format: '小班' as const, note: '原备注' };
    const item: Schedule = { id: 'rr-move@2026-10-05', recurrenceRuleId: rule.id, recurrenceDay: originalDay, day: originalDay, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions, dialog } = setup({ ...createDemoData(), businessDate: '2026-09-22', schedules: [], recurrenceRules: [rule] });
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" draft={{ ...item, day: targetDay, start: '17:00', end: '18:30' }} />);
    expect(screen.getByLabelText('周一')).not.toBeChecked();
    expect(screen.getByLabelText('周三')).toBeChecked();
    expect(screen.getByLabelText('周五')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    expect(screen.getByText(/旧重复规则自 2026年10月5日 停止，新规则从 2026年10月7日 起开始。两者之间不会自动生成课程；已单独调整的课程会保留。/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认本次及以后修改' }));
    expect(actions.replaceRuleFrom).toHaveBeenCalledWith(rule.id, originalDay, expect.objectContaining({ startDate: targetDay, weekdays: [3, 5], start: '17:00', end: '18:30' }));
  });

  it('普通详情的本次及以后改期也会在未手动改重复日时替换源星期', () => {
    const originalDay = '2026-10-05';
    const targetDay = '2026-10-07';
    const rule = { id: 'rr-manual-move', startDate: originalDay, weekdays: [1, 5], enabled: true, start: '16:30', end: '18:00', location: '工作室 B', participants: ['s2', 's3'], format: '小班' as const, note: '' };
    const item: Schedule = { id: 'rr-manual-move@2026-10-05', recurrenceRuleId: rule.id, recurrenceDay: originalDay, day: originalDay, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions, dialog } = setup({ ...createDemoData(), businessDate: '2026-09-22', schedules: [], recurrenceRules: [rule] });
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" />);
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: targetDay } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    dialog();
    expect(screen.getByText('新值').parentElement).toHaveTextContent('重复：每周 三、五');
    fireEvent.click(screen.getByRole('button', { name: '确认本次及以后修改' }));
    expect(actions.replaceRuleFrom).toHaveBeenCalledWith(rule.id, originalDay, expect.objectContaining({ startDate: targetDay, weekdays: [3, 5] }));
  });

  it('本次及以后不能拖回原发生日之前，提示改用仅本次且不发起命令', () => {
    const originalDay = '2026-10-05';
    const rule = { id: 'rr-no-backward', startDate: originalDay, weekdays: [1], enabled: true, start: '16:30', end: '18:00', location: '工作室 B', participants: ['s2', 's3'], format: '小班' as const, note: '' };
    const item: Schedule = { id: 'rr-no-backward@2026-10-05', recurrenceRuleId: rule.id, recurrenceDay: originalDay, day: originalDay, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions } = setup({ ...createDemoData(), businessDate: '2026-09-22', schedules: [], recurrenceRules: [rule] });
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" draft={{ ...item, day: '2026-10-03' }} />);
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('“本次及以后”不能移到原发生日之前；请改用“仅本次”。');
    expect(actions.open).not.toHaveBeenCalled();
    expect(actions.replaceRuleFrom).not.toHaveBeenCalled();
  });

  it('本次及以后修改不会把发生日倒退到原课程之前', () => {
    const data = createDemoData();
    const rule = data.recurrenceRules[0];
    const item: Schedule = { id: `${rule.id}@${rule.startDate}`, recurrenceRuleId: rule.id, recurrenceDay: rule.startDate, day: rule.startDate, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions } = setup(data);
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" />);
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: dateAdd(today, -1) } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('“本次及以后”不能移到原发生日之前；请改用“仅本次”。');
    expect(actions.open).not.toHaveBeenCalled();
  });

  it('短课周历仍显示地点，状态词以文本呈现', () => {
    const data = createDemoData();
    const short: Schedule = { id: 'short', day: data.schedules[0].day, start: '08:00', end: '08:30', location: '短课地点', participants: ['s1'], format: '一对一', note: '不应显示', status: '已完成' };
    const { actions } = setup({ ...data, schedules: [short], recurrenceRules: [], completionRecords: [] });
    actions.ui = { 'schedule.view': 'week' };
    render(<SchedulesPage actions={actions} />);
    const item = screen.getAllByRole('button', { name: /查看 08:00 至 08:30 李雨桐 短课地点 已完成 排期详情/ }).find((button) => button.classList.contains('short-schedule-card'));
    expect(item).toBeDefined();
    expect(item).toHaveTextContent('短课地点');
    expect(item).toHaveTextContent('已完成');
    expect(item).not.toHaveTextContent('不应显示');
  });

  it('重复规则摘要显示对象，详情允许查看名单和编辑', () => {
    const { actions, dialog } = setup();
    render(<SchedulesPage actions={actions} />);
    const summary = screen.getByRole('button', { name: /每周 一、三.*小班 · 2 人.*工作室 B/ });
    expect(summary).not.toHaveTextContent('王浩然');
    fireEvent.click(summary);
    dialog();
    expect(screen.getByText('王浩然、张思远')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑规则' }));
    dialog();
    expect(screen.getByLabelText('生效日期')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看更新确认' })).toBeInTheDocument();
  });

  it('启用会冲突的重复规则时不显示假成功或写入', () => {
    const data = createDemoData();
    const paused = { ...data.recurrenceRules[0], id: 'rr-paused', enabled: false };
    const { actions } = setup({ ...data, recurrenceRules: [...data.recurrenceRules, paused] });
    render(<SchedulesPage actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: '启用规则' }));
    expect(actions.toast).toHaveBeenCalledWith('启用会与未来排期冲突，规则仍保持暂停。', 'warn');
    expect(actions.setRuleEnabled).not.toHaveBeenCalled();
  });

  it('恢复已取消课程先确认，且只写回排期不改变余额', () => {
    const data = createDemoData();
    const cancelled = { ...data.schedules[2], status: '已取消' as const };
    const { actions, dialog } = setup({ ...data, schedules: [...data.schedules.slice(0, 2), cancelled, ...data.schedules.slice(3)] });
    render(<ScheduleDetails actions={actions} item={cancelled} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复排期' }));
    dialog();
    expect(screen.getByText(/不会改动课时余额/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    expect(actions.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: cancelled.id, status: '已排期' }));
    expect(actions.complete).not.toHaveBeenCalled();
    expect(actions.addPayment).not.toHaveBeenCalled();
  });

  it('恢复会冲突时拒绝写入', () => {
    const data = createDemoData();
    const cancelled = { ...data.schedules[2], status: '已取消' as const };
    const collision = { ...data.schedules[1], id: 'collision', start: '19:00', end: '20:00', participants: ['s1'], format: '一对一' as const };
    const { actions } = setup({ ...data, schedules: [...data.schedules.slice(0, 2), cancelled, collision, ...data.schedules.slice(3)] });
    render(<ScheduleDetails actions={actions} item={cancelled} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复排期' }));
    expect(actions.toast).toHaveBeenCalledWith('恢复会与现有排期冲突，请先调整时间。', 'warn');
    expect(actions.saveSchedule).not.toHaveBeenCalled();
  });

  it('已完成课程详情完整展示修订前后字段与原扣课记录', () => {
    const data = createDemoData();
    const completed = { ...data.schedules[0], location: '现地点', participants: ['s2'], note: '现备注' };
    const before = { ...data.schedules[0], location: '原地点', participants: ['s1'], note: '原备注' };
    const { actions } = setup({ ...data, schedules: [completed, ...data.schedules.slice(1)], scheduleRevisions: [{ id: 'sr1', scheduleId: completed.id, changedAt: '2026-09-09T10:00:00.000Z', before, after: completed }] });
    render(<ScheduleDetails actions={actions} item={completed} />);
    expect(screen.getByText('修订记录')).toBeInTheDocument();
    expect(screen.getByText('2026年9月9日 18:00')).toBeInTheDocument();
    expect(screen.getByText(/修订前：.*原地点.*李雨桐.*原备注/)).toBeInTheDocument();
    expect(screen.getByText(/修订后：.*现地点.*王浩然.*现备注/)).toBeInTheDocument();
    expect(screen.getByText('李雨桐：7 → 6 课时')).toBeInTheDocument();
  });

  it('历史课程保留实际上课时间，并单独展示北京时间补录时间', () => {
    const data = createDemoData();
    const historical = { ...data.schedules[0], day: '2026-09-01', start: '09:00', end: '10:30', createdAt: '2026-09-06T01:30:00.000Z' };
    const { actions } = setup({ ...data, businessDate: '2026-09-10', schedules: [historical] });
    render(<ScheduleDetails actions={actions} item={historical} />);
    expect(screen.getByText('时间').parentElement).toHaveTextContent('2026年9月1日 09:00–10:30');
    expect(screen.getByText('补录时间').parentElement).toHaveTextContent('2026年9月6日 09:30（北京时间）');
  });

  it('历史课程当天录入时使用中性录入时间，不误称补录', () => {
    const data = createDemoData();
    const historical = { ...data.schedules[0], day: '2026-09-01', createdAt: '2026-09-01T01:30:00.000Z' };
    const { actions } = setup({ ...data, businessDate: '2026-09-10', schedules: [historical] });
    render(<ScheduleDetails actions={actions} item={historical} />);
    expect(screen.getByText('录入时间').parentElement).toHaveTextContent('2026年9月1日 09:30（北京时间）');
    expect(screen.queryByText('补录时间')).not.toBeInTheDocument();
  });
});
