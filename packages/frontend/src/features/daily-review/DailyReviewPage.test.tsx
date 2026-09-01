import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyReviewPage } from './DailyReviewPage';
import * as dailyReviewApi from '../../api/daily-review';
import type { DailyReviewResult, ScheduleData } from '../../api/types';

vi.mock('../../api/daily-review');

const baseSchedule: ScheduleData = {
  id: 'schedule-1',
  teacherId: 'demo-teacher',
  studentId: 'student-1',
  type: 'lesson',
  title: '张三课程',
  scheduledStart: '2026-07-10T10:00:00.000Z',
  scheduledEnd: '2026-07-10T11:30:00.000Z',
  status: 'planned',
  confidence: 'high',
  pendingFields: null,
  sourceInput: null,
  parentId: null,
  createdAt: '2026-07-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z',
};

const reviewResult: DailyReviewResult = {
  review: {
    plannedCount: 3,
    actualCount: 2,
    cancelledCount: 1,
  },
  schedules: [baseSchedule],
  lessons: [
    { id: 'lesson-1', title: '重点题型复盘', studentName: '张三', status: 'attended' },
  ],
};

beforeEach(() => {
  vi.mocked(dailyReviewApi.assembleDailyReview).mockResolvedValue(reviewResult);
});

describe('DailyReviewPage', () => {
  it('页面基础渲染', () => {
    render(<DailyReviewPage teacherId="demo-teacher" />);

    expect(screen.getByRole('heading', { name: '每日回顾' })).toBeInTheDocument();
    expect(screen.getByLabelText('回顾日期')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成回顾' })).toBeInTheDocument();
  });

  it('点击生成调用 assembleDailyReview 并展示生成中状态', async () => {
    render(<DailyReviewPage teacherId="demo-teacher" />);

    fireEvent.change(screen.getByLabelText('回顾日期'), { target: { value: '2026-07-10' } });
    fireEvent.click(screen.getByRole('button', { name: '生成回顾' }));

    expect(screen.getByRole('button', { name: '生成中' })).toBeDisabled();
    await waitFor(() => expect(dailyReviewApi.assembleDailyReview).toHaveBeenCalledWith('demo-teacher', { date: '2026-07-10' }));
  });

  it('成功后展示回顾统计和列表', async () => {
    render(<DailyReviewPage teacherId="demo-teacher" />);

    fireEvent.change(screen.getByLabelText('回顾日期'), { target: { value: '2026-07-10' } });
    fireEvent.click(screen.getByRole('button', { name: '生成回顾' }));

    expect(await screen.findByText('计划日程')).toBeInTheDocument();
    expect(screen.getByText('实际完成')).toBeInTheDocument();
    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    const schedulesList = screen.getByRole('list', { name: '日程列表' });
    expect(within(schedulesList).getByText('张三课程')).toBeInTheDocument();
    expect(within(schedulesList).getByText('计划中')).toBeInTheDocument();

    const lessonsList = screen.getByRole('list', { name: '课程记录列表' });
    expect(within(lessonsList).getByText('重点题型复盘')).toBeInTheDocument();
    expect(within(lessonsList).getByText('张三')).toBeInTheDocument();
    expect(within(lessonsList).getByText('已上课')).toBeInTheDocument();
  });

  it('assembleDailyReview 失败展示错误状态', async () => {
    vi.mocked(dailyReviewApi.assembleDailyReview).mockRejectedValue(new Error('network down'));

    render(<DailyReviewPage teacherId="demo-teacher" />);

    fireEvent.change(screen.getByLabelText('回顾日期'), { target: { value: '2026-07-10' } });
    fireEvent.click(screen.getByRole('button', { name: '生成回顾' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('回顾生成失败');
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
