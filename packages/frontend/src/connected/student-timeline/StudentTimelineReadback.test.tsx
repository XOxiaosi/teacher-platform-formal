import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentTimelineReadback } from './StudentTimelineReadback';
import type { TimelineEntry } from '../../api/types';

const mock = vi.hoisted(() => ({ timeline: vi.fn() }));
vi.mock('../../api/students', () => ({ getStudentTimeline: mock.timeline }));

const entry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry => ({
  type: 'record', id: 'record-1', occurredAt: '2026-09-20T01:00:00.000Z', title: '课堂观察', summary: '完成分数订正', category: '课堂观察',
  reviewStatus: 'confirmed', visibility: 'internal_only', status: null, score: null, fullScore: null, examName: null, subject: null, communicationDetail: null, ...overrides,
});

beforeEach(() => { vi.resetAllMocks(); mock.timeline.mockResolvedValue({ items: [], total: 0 }); });

describe('StudentTimelineReadback', () => {
  it('reads the authoritative 200-item window and presents all four entry types and count', async () => {
    mock.timeline.mockResolvedValue({ items: [
      entry({ type: 'record', id: 'r', title: '主动订正记录' }),
      entry({ type: 'assessment', id: 'a', title: '阶段测评', score: 88, fullScore: 100, subject: '数学', examName: '期中测验' }),
      entry({ type: 'lesson', id: 'l', title: '数学课', status: 'attended' }),
      entry({ type: 'feedback', id: 'f', title: '家长沟通记录', status: 'reviewed', communicationDetail: { direction: 'inbound', channel: 'wechat', parentType: 'scores', parentConcerns: ['作业节奏'], teacherResponses: ['已约定复习'], agreements: [], followUps: [], nextContactAtTs: null, moderationFlagged: null, moderationReasons: null } }),
    ], total: 245 });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    expect(await screen.findByText('阶段测评')).toBeInTheDocument();
    expect(screen.getByText('主动订正记录')).toBeInTheDocument();
    expect(screen.getByText('课程')).toBeInTheDocument();
    expect(screen.getByText('家长沟通记录')).toBeInTheDocument();
    expect(screen.getByText('88 / 100')).toBeInTheDocument();
    expect(screen.getByText('数学')).toBeInTheDocument();
    expect(screen.getByText('已出勤')).toBeInTheDocument();
    expect(screen.getByText('已审核')).toBeInTheDocument();
    expect(screen.getByText('家长发来')).toBeInTheDocument();
    expect(screen.getByText('微信')).toBeInTheDocument();
    expect(screen.getByText('关注成绩')).toBeInTheDocument();
    expect(screen.getByText('显示 4 / 245 条（最多显示 200 条）')).toBeInTheDocument();
    expect(screen.getAllByText('2026年9月20日 09:00')).toHaveLength(4);
    expect(screen.getByText('家长关注')).toBeInTheDocument();
    expect(mock.timeline).toHaveBeenCalledWith('teacher-a', 'student-a', 200);
  });

  it('shows an explicit empty state', async () => {
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    expect(await screen.findByText('暂无学生时间线记录')).toBeInTheDocument();
    expect(screen.getByText('显示 0 / 0 条（最多显示 200 条）')).toBeInTheDocument();
  });

  it('keeps historical malformed communication arrays from crashing the student detail', async () => {
    mock.timeline.mockResolvedValue({ items: [entry({
      title: '旧沟通记录',
      communicationDetail: {
        direction: 'two_way', channel: 'wechat', parentType: 'normal',
        parentConcerns: [null, '', '补作业'] as unknown as string[],
        teacherResponses: null as unknown as string[], agreements: {} as unknown as string[],
        followUps: ['周五复核', 3] as unknown as string[], nextContactAtTs: null,
        moderationFlagged: true, moderationReasons: [null, '措辞需核对'] as unknown as string[],
      },
    })], total: 1 });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    expect(await screen.findByText('旧沟通记录')).toBeInTheDocument();
    expect(screen.getByText('补作业')).toBeInTheDocument();
    expect(screen.getByText('周五复核')).toBeInTheDocument();
    expect(screen.getByText('措辞需核对')).toBeInTheDocument();
  });

  it('preserves the last successful data when refresh fails and allows retry', async () => {
    mock.timeline.mockResolvedValueOnce({ items: [entry({ title: '旧的权威记录' })], total: 1 }).mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValueOnce({ items: [entry({ title: '新的权威记录' })], total: 1 });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    expect(await screen.findByText('旧的权威记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂不可用');
    expect(screen.getByText('旧的权威记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('新的权威记录')).toBeInTheDocument();
  });

  it('ignores a late response from the former student scope', async () => {
    let resolveOld!: (value: { items: TimelineEntry[]; total: number }) => void;
    const old = new Promise<{ items: TimelineEntry[]; total: number }>((resolve) => { resolveOld = resolve; });
    mock.timeline.mockReturnValueOnce(old).mockResolvedValueOnce({ items: [entry({ id: 'new', title: '新学生记录' })], total: 1 });
    const view = render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    view.rerender(<StudentTimelineReadback teacherId="teacher-a" studentId="student-b" />);
    expect(await screen.findByText('新学生记录')).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [entry({ title: '旧学生迟到记录' })], total: 1 }); });
    expect(screen.queryByText('旧学生迟到记录')).not.toBeInTheDocument();
  });

  it('reloads when refreshToken changes', async () => {
    const view = render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" refreshToken="one" />);
    await screen.findByText('暂无学生时间线记录');
    view.rerender(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" refreshToken="two" />);
    await waitFor(() => expect(mock.timeline).toHaveBeenCalledTimes(2));
  });
});
