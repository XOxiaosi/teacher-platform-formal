import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgendaWeekDocument } from '@teacher-platform/contracts';
import { SchedulesPage } from './SchedulesPage';
import { agendaApi } from '../../api/agenda';
import * as schedulesApi from '../../api/schedules';
import * as studentsApi from '../../api/students';
import type { StudentData } from '../../api/types';

vi.mock('../../api/agenda', () => ({
  agendaApi: {
    getToday: vi.fn(),
    getWeek: vi.fn(),
  },
}));
vi.mock('../../api/schedules');
vi.mock('../../api/students');

const baseStart = '2026-07-10T10:00';
const baseEnd = '2026-07-10T11:30';
const baseStartIso = '2026-07-10T10:00:00.000Z';
const baseEndIso = '2026-07-10T11:30:00.000Z';
const emptyWeekDocument: AgendaWeekDocument = {
  schemaVersion: 1,
  timeZone: 'Asia/Shanghai',
  weekStart: '2030-07-22',
  weekEndExclusive: '2030-07-29',
  generatedAt: '2030-07-22T01:00:00.000Z',
  days: ['2030-07-22', '2030-07-23', '2030-07-24', '2030-07-25', '2030-07-26', '2030-07-27', '2030-07-28']
    .map((date) => ({ date, items: [] })),
};

function schedule(overrides: Partial<schedulesApi.CompleteScheduleResult['schedule']> = {}): schedulesApi.CompleteScheduleResult['schedule'] {
  return {
    id: 'schedule-1',
    teacherId: 'demo-teacher',
    studentId: 'student-1',
    type: 'lesson',
    title: '张三课程',
    scheduledStart: baseStartIso,
    scheduledEnd: baseEndIso,
    status: 'planned',
    confidence: 'high',
    pendingFields: null,
    sourceInput: null,
    parentId: null,
    createdAt: baseStartIso,
    updatedAt: baseStartIso,
    ...overrides,
  };
}

const baseStudent: StudentData = {
  id: 'student-1',
  teacherId: 'demo-teacher',
  name: '张三',
  grade: '高三',
  source: null,
  currentStatus: 'active',
  stageGoal: null,
  createdAt: baseStartIso,
  updatedAt: baseStartIso,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(agendaApi.getWeek).mockResolvedValue(emptyWeekDocument);
  vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [baseStudent], total: 1 });
  vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [schedule()], total: 1 });
  vi.mocked(schedulesApi.createSchedule).mockResolvedValue({
    schedule: schedule({ id: 'schedule-2', title: '李四答疑课', studentId: null, scheduledStart: '2026-07-11T14:00:00.000Z', scheduledEnd: '2026-07-11T15:00:00.000Z' }),
    conflicts: [],
  });
  vi.mocked(schedulesApi.completeSchedule).mockResolvedValue({
    schedule: schedule({ status: 'completed' }),
    lesson: {},
  });
  vi.mocked(schedulesApi.cancelSchedule).mockResolvedValue(schedule({ status: 'cancelled' }));
  vi.mocked(schedulesApi.restoreSchedule).mockResolvedValue(schedule({ status: 'planned' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SchedulesPage', () => {
  it('加载并展示日程列表', async () => {
    render(<SchedulesPage teacherId="demo-teacher" />);

    expect(screen.getByText('正在加载日程课表')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '日程课表' })).toBeInTheDocument();
    expect(screen.getByText('张三课程')).toBeInTheDocument();
    expect(screen.getByText('计划中')).toBeInTheDocument();
    expect(screen.getByText('2026年7月10日 18:00')).toBeInTheDocument();
    expect(schedulesApi.listSchedules).toHaveBeenCalledWith('demo-teacher');
    expect(studentsApi.listStudents).toHaveBeenCalledWith('demo-teacher');
  });

  it('空数据展示空状态', async () => {
    vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [], total: 0 });

    render(<SchedulesPage teacherId="demo-teacher" />);

    expect(await screen.findByText('暂无日程安排。')).toBeInTheDocument();
  });

  it('创建日程调用 createSchedule 并展示新日程', async () => {
    vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [], total: 0 });

    render(<SchedulesPage teacherId="demo-teacher" />);

    await screen.findByText('暂无日程安排。');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '李四答疑课' } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'lesson' } });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-07-11T14:00' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-07-11T15:00' } });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '新增日程' }));

    await waitFor(() => expect(schedulesApi.createSchedule).toHaveBeenCalledWith('demo-teacher', {
      title: '李四答疑课',
      type: 'lesson',
      scheduledStart: '2026-07-11T14:00:00+08:00',
      scheduledEnd: '2026-07-11T15:00:00+08:00',
      studentId: 'student-1',
    }));
    expect(await screen.findByText('李四答疑课')).toBeInTheDocument();
  });

  it('点击完成课程调用 completeSchedule 并更新状态', async () => {
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    fireEvent.click(within(row).getByRole('button', { name: '完成课程' }));

    await waitFor(() => expect(schedulesApi.completeSchedule).toHaveBeenCalledWith('demo-teacher', 'schedule-1'));
    expect(within(row).getByText('已完成')).toBeInTheDocument();
  });

  it('listSchedules 失败展示错误状态', async () => {
    vi.mocked(schedulesApi.listSchedules).mockRejectedValue(new Error('network down'));

    render(<SchedulesPage teacherId="demo-teacher" />);

    expect(await screen.findByText('日程课表加载失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('Week Agenda失败不影响既有创建和完成课程', async () => {
    vi.mocked(agendaApi.getWeek).mockRejectedValue(new Error('week unavailable'));
    render(<SchedulesPage teacherId="demo-teacher" />);

    expect(await screen.findByRole('heading', { name: '周课程表加载失败' })).toBeInTheDocument();
    expect(screen.getByText('week unavailable')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '李四答疑课' } });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: baseStart } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: baseEnd } });
    fireEvent.click(screen.getByRole('button', { name: '新增日程' }));
    await waitFor(() => expect(schedulesApi.createSchedule).toHaveBeenCalledTimes(1));

    const row = screen.getByRole('listitem', { name: /张三课程/ });
    fireEvent.click(within(row).getByRole('button', { name: '完成课程' }));
    await waitFor(() => expect(schedulesApi.completeSchedule).toHaveBeenCalledWith('demo-teacher', 'schedule-1'));
    expect(agendaApi.getWeek).toHaveBeenCalledTimes(1);
  });

  it('非法weekStart显示局部参数错误且不请求Week Agenda', async () => {
    const onNavigate = vi.fn();
    render(
      <SchedulesPage
        teacherId="demo-teacher"
        invalidWeekStart
        onNavigate={onNavigate}
      />,
    );

    expect(await screen.findByRole('heading', { name: '周课程表参数错误' })).toBeInTheDocument();
    expect(screen.getByText('weekStart必须是合法周一日期')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新增日程' })).toBeInTheDocument();
    expect(agendaApi.getWeek).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '返回本周' }));
    expect(onNavigate).toHaveBeenCalledWith('/schedules');
  });

  it('管理列表命中Schedule focus时高亮并无动画滚动', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(<SchedulesPage teacherId="demo-teacher" focusScheduleId="schedule-1" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('planned 项可取消课程并更新为已取消', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    fireEvent.click(within(row).getByRole('button', { name: '取消课程' }));

    await waitFor(() => expect(schedulesApi.cancelSchedule).toHaveBeenCalledWith('demo-teacher', 'schedule-1'));
    expect(confirmSpy).toHaveBeenCalledWith('确定取消这门课程？');
    expect(within(row).getByText('已取消')).toBeInTheDocument();
  });

  it('取消确认被拒绝时不调用 cancelSchedule', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    fireEvent.click(within(row).getByRole('button', { name: '取消课程' }));

    expect(schedulesApi.cancelSchedule).not.toHaveBeenCalled();
    expect(within(row).getByText('计划中')).toBeInTheDocument();
  });

  it('cancelled 项可恢复课程并更新为计划中', async () => {
    vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [schedule({ status: 'cancelled' })], total: 1 });
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    fireEvent.click(within(row).getByRole('button', { name: '恢复课程' }));

    await waitFor(() => expect(schedulesApi.restoreSchedule).toHaveBeenCalledWith('demo-teacher', 'schedule-1'));
    expect(within(row).getByText('计划中')).toBeInTheDocument();
  });

  it('cancelled 项完成课程按钮禁用', async () => {
    vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [schedule({ status: 'cancelled' })], total: 1 });
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    expect(within(row).getByRole('button', { name: '完成课程' })).toBeDisabled();
  });

  it('completed 项不显示取消/恢复按钮', async () => {
    vi.mocked(schedulesApi.listSchedules).mockResolvedValue({ items: [schedule({ status: 'completed' })], total: 1 });
    render(<SchedulesPage teacherId="demo-teacher" />);

    const row = await screen.findByRole('listitem', { name: /张三课程/ });
    expect(within(row).queryByRole('button', { name: '取消课程' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: '恢复课程' })).not.toBeInTheDocument();
  });
});
