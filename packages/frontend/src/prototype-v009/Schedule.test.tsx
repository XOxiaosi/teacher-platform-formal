import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SchedulePage } from './Schedule';
import { createStudio, type Studio } from './model';
import { formatDate } from '../shared/date-format';

function setup() {
  let latest: Studio = createStudio();
  const notify = vi.fn();
  function Harness() {
    const [data, setData] = useState(createStudio);
    latest = data;
    return <SchedulePage data={data} setData={setData} notify={notify} />;
  }
  render(<Harness />);
  return { notify, data: () => latest };
}

describe('V009 排课原型', () => {
  it('普通仅保存同帧确认只新增一次，且冲突时不写入任何课程', async () => {
    const { data, notify } = setup();
    fireEvent.click(screen.getByRole('button', { name: '增加课程' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-09-15' } });
    fireEvent.click(screen.getByLabelText('林小雨'));
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '教室 C' } });
    fireEvent.click(screen.getByRole('button', { name: '查看确认' }));
    const save = screen.getByRole('button', { name: '仅保存课程' });
    act(() => { save.click(); save.click(); });
    await waitFor(() => expect(data().courses).toHaveLength(4));
    expect(data().courses.at(-1)).toMatchObject({ day: '2026-09-15', location: '教室 C', status: 'scheduled' });
    expect(notify).toHaveBeenCalledWith('课程已保存。');

    fireEvent.click(screen.getByRole('button', { name: '增加课程' }));
    fireEvent.click(screen.getByLabelText('陈一诺'));
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '教室 C' } });
    fireEvent.click(screen.getByRole('button', { name: '查看确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('冲突');
    expect(data().courses).toHaveLength(4);
  });

  it('完成课程按每名学生的确认课时一次性记账，不能二次扣课', async () => {
    const { data } = setup();
    fireEvent.click(screen.getByRole('button', { name: /14:00–16:00 林小雨 教室 A/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认完课' }));
    expect(screen.getByLabelText('本次课时')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: '保存并完课' }));
    await waitFor(() => expect(data().ledger).toHaveLength(1));
    expect(data().students.find(student => student.id === 's1')?.balance).toBe(11);
    expect(data().courses.find(course => course.id === 'c1')?.status).toBe('completed');
    fireEvent.click(screen.getByRole('button', { name: /14:00–16:00 林小雨 教室 A/ }));
    expect(screen.getByText('已完成；继续修改课程只修订本次，原扣课流水保持不变。')).toBeInTheDocument();
    expect(data().ledger).toHaveLength(1);
  });

  it('缺席和零课时仍保存出勤记录，负数或非 0.5 步长不会完成课程', async () => {
    const { data } = setup();
    fireEvent.click(screen.getByRole('button', { name: /18:00–20:00 小班 · 2 人 教室 B/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认完课' }));
    fireEvent.change(screen.getAllByLabelText('本次课时')[0], { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并完课' }));
    expect(screen.getByRole('alert')).toHaveTextContent('非负 0.5 课时倍数');
    expect(data().courses.find(course => course.id === 'c2')?.status).toBe('scheduled');
    fireEvent.change(screen.getAllByLabelText('本次课时')[0], { target: { value: '0' } });
    fireEvent.click(screen.getByLabelText('陈一诺 出勤'));
    fireEvent.click(screen.getByRole('button', { name: '保存并完课' }));
    await waitFor(() => expect(data().ledger.filter(item => item.courseId === 'c2')).toHaveLength(2));
    expect(data().ledger.find(item => item.courseId === 'c2' && item.studentId === 's2')).toMatchObject({ attended: false, amount: 0, before: 8, after: 8 });
    expect(data().ledger.find(item => item.courseId === 'c2' && item.studentId === 's3')).toMatchObject({ attended: true, amount: 1, before: 6, after: 5 });
  });

  it('补录可复用自定义 1.5 小时课程，并保存后继续确认完课', async () => {
    const { data } = setup();
    fireEvent.click(screen.getByRole('button', { name: '补录过去课程' }));
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    fireEvent.change(screen.getByLabelText('已有课程'), { target: { value: 'c3' } });
    expect(screen.getByLabelText('结束')).toHaveValue('15:30');
    fireEvent.click(screen.getByRole('button', { name: '查看确认' }));
    fireEvent.click(screen.getByRole('button', { name: '核对出勤并完课' }));
    expect(screen.getByRole('dialog', { name: '确认完课与课时' })).toHaveTextContent(`${formatDate('2026-09-13')} 14:00–15:30`);
    expect(data().courses).toHaveLength(3);
    expect(data().ledger).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '保存并完课' }));
    await waitFor(() => expect(data().ledger).toHaveLength(1));
    expect(data().courses.at(-1)).toMatchObject({ day: '2026-09-13', start: '14:00', end: '15:30', status: 'completed' });
    expect(data().courses.at(-1)?.enteredAt).toContain('2026-09-14T09:00:00+08:00');
  });

  it('取消补录出勤核对不会保存待确认课程', () => {
    const { data } = setup();
    fireEvent.click(screen.getByRole('button', { name: '补录过去课程' }));
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    fireEvent.change(screen.getByLabelText('已有课程'), { target: { value: 'c3' } });
    fireEvent.click(screen.getByRole('button', { name: '查看确认' }));
    fireEvent.click(screen.getByRole('button', { name: '核对出勤并完课' }));
    expect(screen.getByRole('dialog', { name: '确认完课与课时' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(data().courses).toHaveLength(3);
    expect(data().ledger).toHaveLength(0);
  });

  it('同一待确认补录连续确认只写入一次课程和课时流水', async () => {
    const { data } = setup();
    fireEvent.click(screen.getByRole('button', { name: '补录过去课程' }));
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    fireEvent.change(screen.getByLabelText('已有课程'), { target: { value: 'c3' } });
    fireEvent.click(screen.getByRole('button', { name: '查看确认' }));
    fireEvent.click(screen.getByRole('button', { name: '核对出勤并完课' }));
    const save = screen.getByRole('button', { name: '保存并完课' });
    act(() => { save.click(); save.click(); });
    await waitFor(() => expect(data().courses).toHaveLength(4));
    expect(data().courses.filter(course => course.day === '2026-09-13' && course.start === '14:00')).toHaveLength(1);
    expect(data().ledger).toHaveLength(1);
  });

  it('日历放置后先展示旧新值，确认前不改变原课程', async () => {
    const { data } = setup();
    const target = screen.getByText('15').closest('.v9-day');
    fireEvent.drop(target!, { dataTransfer: { getData: () => 'c1' } });
    expect(screen.getByRole('dialog', { name: '确认调整课程' })).toHaveTextContent(`旧值：${formatDate('2026-09-14')} 14:00–16:00`);
    expect(data().courses.find(course => course.id === 'c1')?.day).toBe('2026-09-14');
    fireEvent.click(screen.getByRole('button', { name: '确认调整' }));
    await waitFor(() => expect(data().courses.find(course => course.id === 'c1')?.day).toBe('2026-09-15'));
    expect(data().courses.find(course => course.id === 'c1')?.end).toBe('16:00');
  });
});
