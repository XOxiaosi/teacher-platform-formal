import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgendaItem, AgendaTodayDocument, ObjectReference } from '@teacher-platform/contracts';
import { DashboardPage } from './DashboardPage';
import { agendaApi } from '../../api/agenda';
import * as studentsApi from '../../api/students';
import * as schedulesApi from '../../api/schedules';
import * as paymentsApi from '../../api/payments';
import * as aiInputApi from '../../api/ai-input';

vi.mock('../../api/agenda', () => ({
  agendaApi: {
    getToday: vi.fn(),
    getWeek: vi.fn(),
  },
}));
vi.mock('../../api/students', () => ({ listStudents: vi.fn() }));
vi.mock('../../api/schedules', () => ({ listSchedules: vi.fn() }));
vi.mock('../../api/payments', () => ({ listPayments: vi.fn() }));
vi.mock('../../api/ai-input', () => ({ saveRawInput: vi.fn() }));

const scheduleReference: ObjectReference = {
  id: 'Schedule:schedule-1',
  type: 'Schedule',
  objectId: 'schedule-1',
  label: '张三课程',
};
const studentReference: ObjectReference = {
  id: 'Student:student-1',
  type: 'Student',
  objectId: 'student-1',
  label: '张三',
};
const memoReference: ObjectReference = {
  id: 'Memo:memo-1',
  type: 'Memo',
  objectId: 'memo-1',
  label: '补发讲义',
};

function agendaItem(overrides: Partial<AgendaItem> & Pick<AgendaItem, 'id' | 'kind' | 'title'>): AgendaItem {
  const { id, kind, title, ...optional } = overrides;
  return {
    id,
    kind,
    title,
    allDay: kind !== 'lesson',
    status: 'active',
    sourceRef: memoReference,
    actions: [],
    ...optional,
  };
}

function todayDocument(overrides: Partial<AgendaTodayDocument> = {}): AgendaTodayDocument {
  return {
    schemaVersion: 1,
    timeZone: 'Asia/Shanghai',
    businessDate: '2030-07-24',
    generatedAt: '2030-07-24T01:30:00.000Z',
    items: [
      agendaItem({
        id: 'schedule:schedule-1',
        kind: 'lesson',
        title: '张三课程',
        startAt: '2030-07-24T01:00:00.000Z',
        endAt: '2030-07-24T02:30:00.000Z',
        allDay: false,
        status: 'planned',
        sourceRef: scheduleReference,
        studentRef: studentReference,
        actions: [{
          id: 'open-schedule',
          kind: 'open-reference',
          label: '查看张三课程',
          referenceId: scheduleReference.id,
        }],
      }),
      agendaItem({
        id: 'pending-action:pending-1',
        kind: 'pending_action',
        title: '确认暂停学生',
        startAt: '2030-07-24T03:00:00.000Z',
        status: 'pending',
        sourceRef: studentReference,
        actions: [{
          id: 'open-student',
          kind: 'open-reference',
          label: '查看张三',
          referenceId: studentReference.id,
        }],
      }),
      agendaItem({
        id: 'memo:memo-1',
        kind: 'memo',
        title: '补发讲义',
        startAt: '2030-07-23T15:00:00.000Z',
        status: 'active',
        sourceRef: memoReference,
        actions: [{
          id: 'open-memo',
          kind: 'open-reference',
          label: '查看补发讲义',
          referenceId: memoReference.id,
        }],
      }),
      agendaItem({
        id: 'custom:1',
        kind: 'custom_reminder',
        title: '整理实验器材',
        sourceRef: memoReference,
        actions: [{
          id: 'unsafe-action',
          kind: 'open-reference',
          label: '不安全链接',
          referenceId: 'missing-reference',
        }],
      }),
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agendaApi.getToday).mockResolvedValue(todayDocument());
  vi.mocked(studentsApi.listStudents).mockRejectedValue(new Error('legacy students API called'));
  vi.mocked(schedulesApi.listSchedules).mockRejectedValue(new Error('legacy schedules API called'));
  vi.mocked(paymentsApi.listPayments).mockRejectedValue(new Error('legacy payments API called'));
  vi.mocked(aiInputApi.saveRawInput).mockRejectedValue(new Error('legacy raw input API called'));
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('DashboardPage Agenda Today', () => {
  it('只读取Agenda并按服务端businessDate展示四组内容与受控导航', async () => {
    const onNavigate = vi.fn();
    render(<DashboardPage teacherId="teacher-a" onNavigate={onNavigate} />);

    expect(screen.getByText('正在加载今日安排')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '7月24日 · 星期三' })).toBeInTheDocument();
    expect(screen.getByText('1节课程，1项待确认，1条到期备忘。')).toBeInTheDocument();
    expect(screen.getByText('09:00–10:30')).toBeInTheDocument();
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getByText('计划中')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '待确认动作' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '到期备忘' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '其他提醒' })).toBeInTheDocument();
    expect(screen.getByText('整理实验器材')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '不安全链接' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: '查看张三课程' }));
    expect(onNavigate).toHaveBeenCalledWith('/schedules?focus=schedule-1');
    fireEvent.click(screen.getByRole('link', { name: '打开每日回顾' }));
    expect(onNavigate).toHaveBeenCalledWith('/today?view=review');

    expect(agendaApi.getToday).toHaveBeenCalledTimes(1);
    expect(agendaApi.getToday).toHaveBeenCalledWith('teacher-a');
    expect(studentsApi.listStudents).not.toHaveBeenCalled();
    expect(schedulesApi.listSchedules).not.toHaveBeenCalled();
    expect(paymentsApi.listPayments).not.toHaveBeenCalled();
    expect(aiInputApi.saveRawInput).not.toHaveBeenCalled();
    expect(screen.queryByText('学生总数')).not.toBeInTheDocument();
    expect(screen.queryByText('AI 快速输入')).not.toBeInTheDocument();
  });

  it('成功空文档显示三个明确空态', async () => {
    vi.mocked(agendaApi.getToday).mockResolvedValue(todayDocument({ items: [] }));

    render(<DashboardPage teacherId="teacher-a" onNavigate={() => undefined} />);

    expect(await screen.findByText('今天没有课程安排。')).toBeInTheDocument();
    expect(screen.getByText('当前没有待确认动作。')).toBeInTheDocument();
    expect(screen.getByText('当前没有到期备忘。')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '其他提醒' })).not.toBeInTheDocument();
  });

  it('首次失败显示错误并可只重试Today API', async () => {
    vi.mocked(agendaApi.getToday)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(todayDocument());

    render(<DashboardPage teacherId="teacher-a" onNavigate={() => undefined} />);

    expect(await screen.findByRole('heading', { name: '今日安排加载失败' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('network down');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('张三课程')).toBeInTheDocument();
    expect(agendaApi.getToday).toHaveBeenCalledTimes(2);
    expect(studentsApi.listStudents).not.toHaveBeenCalled();
  });

  it('刷新失败保留旧文档并显示局部错误', async () => {
    render(<DashboardPage teacherId="teacher-a" onNavigate={() => undefined} />);
    await screen.findByText('张三课程');
    vi.mocked(agendaApi.getToday).mockRejectedValueOnce(new Error('refresh down'));

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    expect(await screen.findByText('刷新失败：refresh down')).toBeInTheDocument();
    expect(screen.getByText('张三课程')).toBeInTheDocument();
    expect(agendaApi.getToday).toHaveBeenCalledTimes(2);
  });

  it('teacher切换后忽略较旧请求结果', async () => {
    const teacherA = deferred<AgendaTodayDocument>();
    const teacherB = deferred<AgendaTodayDocument>();
    vi.mocked(agendaApi.getToday)
      .mockReturnValueOnce(teacherA.promise)
      .mockReturnValueOnce(teacherB.promise);
    const { rerender } = render(
      <DashboardPage teacherId="teacher-a" onNavigate={() => undefined} />,
    );

    rerender(<DashboardPage teacherId="teacher-b" onNavigate={() => undefined} />);
    await act(async () => {
      teacherB.resolve(todayDocument({
        businessDate: '2030-07-25',
        items: [agendaItem({ id: 'memo:b', kind: 'memo', title: 'B老师事项' })],
      }));
    });
    expect(await screen.findByText('B老师事项')).toBeInTheDocument();

    await act(async () => {
      teacherA.resolve(todayDocument({ items: [agendaItem({ id: 'memo:a', kind: 'memo', title: 'A老师事项' })] }));
    });
    await waitFor(() => expect(screen.queryByText('A老师事项')).not.toBeInTheDocument());
    expect(screen.getByText('B老师事项')).toBeInTheDocument();
  });

  it('focusMemo命中时高亮并无动画滚动，未命中不报错', async () => {
    const { rerender } = render(
      <DashboardPage teacherId="teacher-a" focusMemo="memo-1" onNavigate={() => undefined} />,
    );

    const title = await screen.findByText('补发讲义');
    expect(title.closest('[aria-current="true"]')).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });

    rerender(
      <DashboardPage teacherId="teacher-a" focusMemo="missing" onNavigate={() => undefined} />,
    );
    expect(screen.getByText('补发讲义')).toBeInTheDocument();
  });

  it('无效lesson instant降级为时间不可用而不崩溃', async () => {
    vi.mocked(agendaApi.getToday).mockResolvedValue(todayDocument({
      items: [agendaItem({
        id: 'schedule:invalid',
        kind: 'lesson',
        title: '时间异常课程',
        allDay: false,
        status: 'planned',
        startAt: 'invalid',
        endAt: '2030-07-24T02:30:00.000Z',
        sourceRef: scheduleReference,
      })],
    }));

    render(<DashboardPage teacherId="teacher-a" onNavigate={() => undefined} />);

    expect(await screen.findByText('时间异常课程')).toBeInTheDocument();
    expect(screen.getByText('时间不可用')).toBeInTheDocument();
  });
});
