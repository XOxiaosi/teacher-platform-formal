import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentTimelineReadback } from './StudentTimelineReadback';
import type { TimelineEntry } from '../../api/types';

const mock = vi.hoisted(() => ({ timeline: vi.fn(), detail: vi.fn(), source: vi.fn() }));
vi.mock('../../api/students', () => ({ getStudentTimeline: mock.timeline, getStudentTimelineDetail: mock.detail, getStudentRecordSource: mock.source }));

const entry = (overrides: Partial<TimelineEntry> = {}): TimelineEntry => {
  const type = overrides.type ?? 'record';
  const target = overrides.openTarget ?? (type === 'lesson' ? { type: 'lesson' as const, lessonId: overrides.id ?? 'lesson-1' } : type === 'feedback' ? { type: 'feedback' as const, feedbackId: overrides.id ?? 'feedback-1' } : { type, recordId: overrides.id ?? 'record-1', sourceRecordId: null });
  return { type, id: 'record-1', occurredAt: '2026-09-20T01:00:00.000Z', title: '课堂观察', summary: '完成分数订正', category: 'general_note', reviewStatus: 'confirmed', visibility: 'internal_only', status: null, score: null, fullScore: null, examName: null, subject: null, communicationDetail: null, openTarget: target, ...overrides };
};
const page = (items: TimelineEntry[], total = items.length, extra: Partial<{ page: number; hasMore: boolean }> = {}) => ({ items, total, page: extra.page ?? 1, pageSize: 50, hasMore: extra.hasMore ?? false });
const recordDetail = { type: 'record' as const, record: { id: 'record-1', teacherId: 'teacher-a', studentId: 'student-a', sourceRecordId: 'source-1', category: 'general_note', occurredAt: '2026-09-20T01:00:00.000Z', summary: '正式详情', structuredData: null, confidence: 'high', reviewStatus: 'confirmed', visibility: 'internal_only', importance: 'normal', supersedesId: null, createdAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z' } };

beforeEach(() => { vi.resetAllMocks(); mock.timeline.mockResolvedValue(page([])); mock.detail.mockResolvedValue(recordDetail); mock.source.mockResolvedValue({ recordId: 'record-1', state: 'none', source: null }); });

describe('StudentTimelineReadback', () => {
  it('reads page size 50 and renders the four entry types and filtered count', async () => {
    mock.timeline.mockResolvedValue(page([
      entry({ type: 'record', id: 'r', title: '主动订正记录' }), entry({ type: 'assessment', id: 'a', title: '阶段测评', score: 88, fullScore: 100, subject: '数学', examName: '期中测验' }), entry({ type: 'lesson', id: 'l', title: '数学课', status: 'attended' }), entry({ type: 'feedback', id: 'f', title: '家长沟通记录', status: 'reviewed', communicationDetail: { direction: 'inbound', channel: 'wechat', parentType: 'scores', parentConcerns: ['作业节奏'], teacherResponses: ['已约定复习'], agreements: [], followUps: [], nextContactAtTs: null, moderationFlagged: null, moderationReasons: null } }),
    ], 245, { hasMore: true }));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    expect(await screen.findByText('阶段测评')).toBeInTheDocument();
    expect(screen.getByText('主动订正记录')).toBeInTheDocument(); expect(screen.getAllByText('课程').length).toBeGreaterThan(0); expect(screen.getByText('家长沟通记录')).toBeInTheDocument(); expect(screen.getByText('88 / 100')).toBeInTheDocument(); expect(screen.getByText('已出勤')).toBeInTheDocument(); expect(screen.getByText('已审核')).toBeInTheDocument(); expect(screen.getByText('微信')).toBeInTheDocument(); expect(screen.getByText('已显示 4 / 245 条')).toBeInTheDocument();
    expect(mock.timeline).toHaveBeenCalledWith('teacher-a', 'student-a', { page: 1, pageSize: 50 });
  });

  it('converts Beijing date range to a half-open server query and applies source/category filters', async () => {
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByText('暂无学生时间线记录');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } }); fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-30' } }); const sourceFieldset = screen.getByText('内容来源').closest('fieldset')!; const categoryFieldset = screen.getByText('正式记录类别').closest('fieldset')!; fireEvent.click(within(sourceFieldset).getByRole('checkbox', { name: '档案记录' })); fireEvent.click(within(categoryFieldset).getByRole('checkbox', { name: '测评' })); fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    await waitFor(() => expect(mock.timeline).toHaveBeenLastCalledWith('teacher-a', 'student-a', { page: 1, pageSize: 50, from: '2026-09-01T00:00:00+08:00', to: '2026-10-01T00:00:00+08:00', types: ['record'], categories: ['assessment'] }));
  });

  it('loads another page without replacing the previous items', async () => {
    mock.timeline.mockResolvedValueOnce(page([entry({ title: '第一页' })], 2, { hasMore: true })).mockResolvedValueOnce(page([entry({ id: 'second', title: '第二页' })], 2, { page: 2 }));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByText('第一页'); fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('第二页')).toBeInTheDocument(); expect(screen.getByText('已显示 2 / 2 条')).toBeInTheDocument(); expect(mock.timeline).toHaveBeenLastCalledWith('teacher-a', 'student-a', { page: 2, pageSize: 50 });
  });

  it('retries a failed next page without dropping or duplicating earlier entries', async () => {
    mock.timeline
      .mockResolvedValueOnce(page([entry({ title: '已加载第一页' })], 2, { hasMore: true }))
      .mockRejectedValueOnce(new Error('下一页暂不可用'))
      .mockResolvedValueOnce(page([entry({ id: 'second', title: '恢复后的第二页' })], 2, { page: 2 }));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    await screen.findByText('已加载第一页');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('下一页暂不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('恢复后的第二页')).toBeInTheDocument();
    expect(screen.getByText('已加载第一页')).toBeInTheDocument();
    expect(mock.timeline).toHaveBeenLastCalledWith('teacher-a', 'student-a', { page: 2, pageSize: 50 });
  });

  it('does not append a new-filter page onto preserved results from the previous filter', async () => {
    mock.timeline
      .mockResolvedValueOnce(page([entry({ title: '旧筛选第一页' })], 80, { hasMore: true }))
      .mockRejectedValueOnce(new Error('新筛选第一页失败'));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    await screen.findByText('旧筛选第一页');
    fireEvent.click(screen.getByRole('checkbox', { name: '目标' }));
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('新筛选第一页失败');
    expect(screen.getByText('已显示 1 / 80 条（上一结果）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mock.timeline).toHaveBeenLastCalledWith('teacher-a', 'student-a', {
      page: 1,
      pageSize: 50,
      categories: ['goal'],
    });
  });

  it('distinguishes filtered empty state and validates reversed dates', async () => {
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByText('暂无学生时间线记录');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-01' } }); fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-01' } }); fireEvent.click(screen.getByRole('button', { name: '应用筛选' })); expect(screen.getByRole('alert')).toHaveTextContent('开始日期不能晚于结束日期'); expect(mock.timeline).toHaveBeenCalledTimes(1);
  });

  it('keeps the last successful result when a refresh fails and retries', async () => {
    mock.timeline.mockResolvedValueOnce(page([entry({ title: '旧结果' })])).mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValueOnce(page([entry({ title: '新结果' })]));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByText('旧结果'); fireEvent.click(screen.getByRole('button', { name: '刷新' })); expect(await screen.findByRole('alert')).toHaveTextContent('当前显示上一结果'); expect(screen.getByText('旧结果')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '重试' })); expect(await screen.findByText('新结果')).toBeInTheDocument();
  });

  it('isolates late responses after a student switch', async () => {
    let resolveOld!: (value: ReturnType<typeof page>) => void; const old = new Promise<ReturnType<typeof page>>((resolve) => { resolveOld = resolve; }); mock.timeline.mockReturnValueOnce(old).mockResolvedValueOnce(page([entry({ id: 'new', title: '新学生记录' })]));
    const view = render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); view.rerender(<StudentTimelineReadback teacherId="teacher-a" studentId="student-b" />); expect(await screen.findByText('新学生记录')).toBeInTheDocument(); await act(async () => resolveOld(page([entry({ title: '旧学生迟到记录' })]))); expect(screen.queryByText('旧学生迟到记录')).not.toBeInTheDocument();
  });

  it('opens record detail and independently displays deleted source without raw text', async () => {
    mock.source.mockResolvedValue({ recordId: 'record-1', state: 'deleted', source: { id: 'source-1', sourceType: 'text', captureStatus: 'deleted', rawText: null, occurredAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z' } }); mock.timeline.mockResolvedValue(page([entry({ openTarget: { type: 'record', recordId: 'record-1', sourceRecordId: 'source-1' } })]));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByRole('heading', { name: '课堂观察' }); fireEvent.click(screen.getByRole('button', { name: '查看原记录与来源' })); expect(await screen.findByRole('dialog')).toHaveTextContent('正式详情'); expect(await screen.findByText(/原件已删除/)).toBeInTheDocument(); expect(screen.queryByText('来源原文')).not.toBeInTheDocument(); expect(mock.detail).toHaveBeenCalledWith('teacher-a', 'student-a', 'record', 'record-1'); expect(mock.source).toHaveBeenCalledWith('teacher-a', 'student-a', 'record-1');
  });

  it('traps focus in the modal, closes on Escape, and restores the trigger focus', async () => {
    mock.timeline.mockResolvedValue(page([entry()]));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    await screen.findByRole('heading', { name: '课堂观察' });
    const trigger = screen.getByRole('button', { name: '查看原记录与来源' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: '关闭详情' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it.each([
    ['available', '原文可查看'],
    ['none', '无关联来源材料。'],
    ['deleted', '原件已删除'],
    ['unavailable', '当前不可用'],
  ] as const)('renders source state %s without guessing its meaning', async (state, text) => {
    mock.timeline.mockResolvedValue(page([entry({ openTarget: { type: 'record', recordId: 'record-1', sourceRecordId: state === 'none' ? null : 'source-1' } })]));
    mock.source.mockResolvedValue({ recordId: 'record-1', state, source: state === 'available' ? { id: 'source-1', sourceType: 'text', captureStatus: 'captured', rawText: '原始材料', occurredAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z' } : null });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByRole('heading', { name: '课堂观察' }); fireEvent.click(screen.getByRole('button', { name: '查看原记录与来源' })); expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    if (state === 'deleted') expect(screen.queryByText('原始材料')).not.toBeInTheDocument();
  });

  it('keeps detail and reports a source network failure separately', async () => {
    mock.timeline.mockResolvedValue(page([entry({ openTarget: { type: 'record', recordId: 'record-1', sourceRecordId: 'source-1' } })])); mock.source.mockRejectedValue(new Error('来源断网'));
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByRole('heading', { name: '课堂观察' }); fireEvent.click(screen.getByRole('button', { name: '查看原记录与来源' })); expect(await screen.findByRole('alert')).toHaveTextContent('原记录已读取，但来源读取失败：来源断网'); expect(screen.getByText('正式详情')).toBeInTheDocument();
  });

  it('rejects a mismatched detail response before reading its source', async () => {
    mock.timeline.mockResolvedValue(page([entry()]));
    mock.detail.mockResolvedValue({
      ...recordDetail,
      record: { ...recordDetail.record, studentId: 'student-b' },
    });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />);
    await screen.findByRole('heading', { name: '课堂观察' });
    fireEvent.click(screen.getByRole('button', { name: '查看原记录与来源' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('归属或类型不匹配');
    expect(mock.source).not.toHaveBeenCalled();
  });

  it('does not request record source for lesson and feedback details', async () => {
    mock.timeline.mockResolvedValue(page([entry({ type: 'lesson', id: 'lesson-1', title: '课程详情', openTarget: { type: 'lesson', lessonId: 'lesson-1' } })])); mock.detail.mockResolvedValue({ type: 'lesson', lesson: { id: 'lesson-1', teacherId: 'teacher-a', studentId: 'student-a', scheduleId: 'schedule-1', date: '2026-09-20T01:00:00.000Z', status: 'attended', progress: '完成练习', studentState: null, homework: null, teacherNote: '需复习', sourceNoteId: null, createdAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z' } });
    render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" />); await screen.findByText('课程详情'); fireEvent.click(screen.getByRole('button', { name: '查看原记录与来源' })); expect(await screen.findByText('课程详情没有单独采集来源材料。')).toBeInTheDocument(); expect(mock.source).not.toHaveBeenCalled();
  });

  it('reloads on refreshToken changes', async () => { const view = render(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" refreshToken="one" />); await screen.findByText('暂无学生时间线记录'); view.rerender(<StudentTimelineReadback teacherId="teacher-a" studentId="student-a" refreshToken="two" />); await waitFor(() => expect(mock.timeline).toHaveBeenCalledTimes(2)); });
});
