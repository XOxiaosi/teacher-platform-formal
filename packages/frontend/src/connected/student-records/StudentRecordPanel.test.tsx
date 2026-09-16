import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentRecordPanel } from './StudentRecordPanel';
import { deferred, record } from './test-fixtures';
import type { ListResult, StudentRecordItem } from '../../api/types';
const mock = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn(), source: vi.fn() }));
vi.mock('../../api/students', () => ({ listStudentRecords: mock.list, reviewStudentRecord: mock.review, getStudentRecordSource: mock.source }));
beforeEach(() => { vi.resetAllMocks(); mock.list.mockResolvedValue({ items: [record()], total: 1 }); });
const mount = () => render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />);
describe('complete formal record panel', () => {
  it('uses business labels and keeps internal identifiers in optional trace details', async () => {
    mock.list.mockResolvedValue({ items: [record({ category: 'lesson_observation', structuredData: { observation: '自主检查步骤', captureEventId: 'capture-123', scheduleId: 'schedule-456', unknownSystemField: '技术内部值' } })], total: 1 });
    mount(); await screen.findByRole('article');
    expect(screen.getByRole('heading', { name: '课堂观察' })).toBeInTheDocument();
    expect(screen.getByText('观察内容')).toBeInTheDocument(); expect(screen.getByText('自主检查步骤')).toBeInTheDocument();
    expect(screen.getByText('来源材料编号：capture-123').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('关联课程编号：schedule-456').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByText(/unknownSystemField|技术内部值/)).not.toBeInTheDocument();
  });
  it('reads more than one page and displays full content and exact version', async () => {
    const all = Array.from({ length: 125 }, (_, i) => record({ id: `r${i}`, summary: `完整记录 ${i}` }));
    mock.list.mockResolvedValueOnce({ items: all.slice(0, 100), total: 125 }).mockResolvedValueOnce({ items: all.slice(100), total: 125 });
    mount(); await screen.findByText('共 125 条记录 · 时间均为北京时间');
    expect(screen.getAllByRole('article')).toHaveLength(125);
    expect(mock.list.mock.calls).toEqual([['teacher-a', 's1', { page: 1, pageSize: 100 }], ['teacher-a', 's1', { page: 2, pageSize: 100 }]]);
    const last = within(screen.getAllByRole('article')[124]);
    expect(last.getByText('完整记录 124')).toBeInTheDocument();
    expect(last.getByText(`当前版本：${all[124].updatedAt}`)).toBeInTheDocument();
  });
  it('does not present partial results as complete when a later page fails, and can retry', async () => {
    mock.list.mockResolvedValueOnce({ items: [record()], total: 2 }).mockRejectedValueOnce(new Error('第二页失败'));
    mount(); await screen.findByText(/本次未能读取完整记录。第二页失败/);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByText(/共 .* 条记录/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    await screen.findByText('共 1 条记录 · 时间均为北京时间');
  });
  it('stops repeated pages instead of looping or silently dropping records', async () => {
    mock.list.mockResolvedValue({ items: [record()], total: 2 }); mount();
    await screen.findByText(/记录顺序发生变化/); expect(mock.list).toHaveBeenCalledTimes(2);
  });
  it('disables old records when refresh fails and reloads when the parent token changes', async () => {
    const view = render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" refreshToken={1} />);
    await screen.findByRole('article');
    mock.list.mockRejectedValueOnce(new Error('刷新失败'));
    view.rerender(<StudentRecordPanel teacherId="teacher-a" studentId="s1" refreshToken={2} />);
    await screen.findByText(/下方保留上次记录/);
    expect(screen.getByLabelText('调整分享范围')).toBeDisabled();
    mock.list.mockResolvedValue({ items: [record({ summary: '同页新增成功后刷新' })], total: 1 });
    view.rerender(<StudentRecordPanel teacherId="teacher-a" studentId="s1" refreshToken={3} />);
    await screen.findByText('同页新增成功后刷新');
  });
  it('isolates teacher and student scopes and ignores a former scope late response', async () => {
    const old = deferred<ListResult<StudentRecordItem>>(); mock.list.mockReturnValueOnce(old.promise);
    const view = mount();
    mock.list.mockResolvedValue({ items: [record({ teacherId: 'teacher-b', studentId: 's2', summary: '乙教师学生' })], total: 1 });
    view.rerender(<StudentRecordPanel teacherId="teacher-b" studentId="s2" />);
    await screen.findByText('乙教师学生');
    await act(async () => old.resolve({ items: [record({ summary: '甲教师旧响应' })], total: 1 }));
    expect(screen.queryByText('甲教师旧响应')).not.toBeInTheDocument();
  });
  it('rejects records from another owner', async () => {
    mock.list.mockResolvedValue({ items: [record({ teacherId: 'teacher-b' })], total: 1 }); mount();
    await screen.findByText(/记录归属不匹配/); expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});

describe('source originals', () => {
  it('separates full original text from saved content and reloads source on record refresh', async () => {
    mock.source.mockResolvedValue({ recordId: 'r1', state: 'available', source: { id: 'source1', sourceType: 'text', captureStatus: 'captured', rawText: '来源原文完整\n家长转述而非教师观察。', occurredAt: record().occurredAt, updatedAt: record().updatedAt } });
    mount(); fireEvent.click(await screen.findByRole('button', { name: '查看来源原文' }));
    expect(await screen.findByText(/来源原文完整/)).toHaveTextContent('家长转述而非教师观察。');
    mock.source.mockResolvedValue({ recordId: 'r1', state: 'deleted', source: { id: 'source1', sourceType: 'text', captureStatus: 'deleted', rawText: '不应泄露的缓存', occurredAt: record().occurredAt, updatedAt: record().updatedAt } });
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    await screen.findByText(/来源材料已删除/);
    expect(screen.queryByText(/来源原文完整/)).not.toBeInTheDocument(); expect(screen.queryByText('不应泄露的缓存')).not.toBeInTheDocument();
    expect(screen.getByText(/教师核对后的完整记录/)).toBeInTheDocument();
    expect(screen.getByText(/来源类型：文本材料/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起来源原文' }));
    expect(screen.getByText('来源状态：原件已删除')).toBeInTheDocument();
  });
  it('distinguishes unavailable source from network failure with retry', async () => {
    mock.source.mockRejectedValueOnce(new Error('来源断网')).mockResolvedValue({ recordId: 'r1', state: 'unavailable', source: null });
    mount(); fireEvent.click(await screen.findByRole('button', { name: '查看来源原文' }));
    await screen.findByText(/来源读取失败：来源断网/);
    fireEvent.click(screen.getByRole('button', { name: '重试读取来源' }));
    await screen.findByText('来源当前不可用，不能核对原文。');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('ignores a source response from the previous student', async () => {
    const late = deferred<unknown>(); mock.source.mockReturnValueOnce(late.promise);
    const view = mount(); fireEvent.click(await screen.findByRole('button', { name: '查看来源原文' }));
    mock.list.mockResolvedValue({ items: [record({ studentId: 's2', sourceRecordId: null })], total: 1 });
    view.rerender(<StudentRecordPanel teacherId="teacher-a" studentId="s2" />);
    await screen.findByText('来源：无关联来源材料');
    await act(async () => late.resolve({ recordId: 'r1', state: 'available', source: { id: 'source1', rawText: '旧学生隐私' } }));
    expect(screen.queryByText('旧学生隐私')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.source).toHaveBeenCalledTimes(1));
  });
});
