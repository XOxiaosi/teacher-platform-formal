import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoData, today, type DemoData, type Schedule } from './data';
import type { PreviewActions } from './PreviewApp';
import { dateAdd, isoWeekday } from './recurrence';
import { dateRangeLabel, SchedulesPage } from './SchedulePage';
import { ScheduleDetails } from './ScheduleDetails';
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

describe('日程交互修复', () => {
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

  it('本次及以后修改日期不在重复星期时，确认前阻止保存', () => {
    const data = createDemoData();
    const rule = data.recurrenceRules[0];
    let originalDay = rule.startDate;
    while (!rule.weekdays.includes(isoWeekday(originalDay))) originalDay = dateAdd(originalDay, 1);
    const item: Schedule = { id: `${rule.id}@${originalDay}`, recurrenceRuleId: rule.id, recurrenceDay: originalDay, day: originalDay, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions } = setup(data);
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" />);
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: dateAdd(originalDay, 1) } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('修改后的日期须包含在重复星期中，请调整日期或重复星期。');
    expect(actions.open).not.toHaveBeenCalled();
  });

  it('本次及以后修改不会接受今天之前的生效日期', () => {
    const data = createDemoData();
    const rule = data.recurrenceRules[0];
    const item: Schedule = { id: `${rule.id}@${rule.startDate}`, recurrenceRuleId: rule.id, recurrenceDay: rule.startDate, day: rule.startDate, start: rule.start, end: rule.end, location: rule.location, participants: rule.participants, format: rule.format, note: rule.note, status: '已排期' };
    const { actions } = setup(data);
    render(<EditScheduleForm actions={actions} schedule={item} scope="future" />);
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: dateAdd(today, -1) } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('本次及以后的修改日期不能早于今天。');
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
