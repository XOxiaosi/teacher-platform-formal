import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { StudentRecordPanel } from './StudentRecordPanel';
import { deferred, record } from './test-fixtures';
const mock = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn(), source: vi.fn() }));
vi.mock('../../api/students', () => ({ listStudentRecords: mock.list, reviewStudentRecord: mock.review, getStudentRecordSource: mock.source }));
beforeEach(() => { vi.resetAllMocks(); mock.list.mockResolvedValue({ items: [record()], total: 1 }); });
const chooseShare = () => fireEvent.change(screen.getByLabelText('调整分享范围'), { target: { value: 'parent_shareable' } });
describe('record review and visibility recovery', () => {
  it('supports explicit candidate rejection then restoring the rejected record', async () => {
    mock.list.mockResolvedValue({ items: [record({ reviewStatus: 'candidate' })], total: 1 });
    mock.review.mockResolvedValueOnce(record({ reviewStatus: 'rejected', updatedAt: '2026-09-16T02:00:00.000Z' }))
      .mockResolvedValueOnce(record({ reviewStatus: 'confirmed', updatedAt: '2026-09-16T03:00:00.000Z' }));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />); await screen.findByRole('article');
    fireEvent.change(screen.getByLabelText('审核结果'), { target: { value: 'rejected' } });
    fireEvent.click(screen.getByRole('button', { name: '保存审核结果' }));
    await screen.findByText(/已保存。分享范围/);
    expect(screen.getByLabelText('审核结果')).toHaveValue('confirmed');
    fireEvent.click(screen.getByRole('button', { name: '保存审核结果' }));
    await waitFor(() => expect(screen.queryByLabelText('审核结果')).not.toBeInTheDocument());
    expect(mock.review.mock.calls.map((args) => args[3])).toEqual(['rejected', 'confirmed']);
  });
  it('confirmed records only expose explicit visibility changes, bound to displayed version', async () => {
    const pending = deferred<ReturnType<typeof record>>(); mock.review.mockReturnValue(pending.promise);
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" onRecordsChanged={changed} />);
    await screen.findByRole('article');
    expect(screen.queryByLabelText('审核结果')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled();
    chooseShare(); expect(mock.review).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    fireEvent.click(screen.getByRole('button', { name: '处理中…' }));
    expect(mock.review).toHaveBeenCalledTimes(1);
    expect(mock.review).toHaveBeenCalledWith('teacher-a', 's1', 'r1', 'confirmed', 'parent_shareable', record().updatedAt);
    await act(async () => pending.resolve(record({ visibility: 'parent_shareable', updatedAt: '2026-09-16T02:00:00.000Z' })));
    await screen.findByText(/已保存。分享范围只表示教师授权/); expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled();
  });
  it('keeps saved state when parent refresh fails, without allowing repeated save', async () => {
    mock.review.mockResolvedValue(record({ visibility: 'parent_shareable', updatedAt: '2026-09-16T02:00:00.000Z' }));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" onRecordsChanged={vi.fn().mockRejectedValue(new Error('父页面失败'))} />);
    await screen.findByRole('article'); chooseShare(); fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    await screen.findByText(/已保存，其他页面暂未刷新/);
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled();
    expect(mock.review).toHaveBeenCalledTimes(1);
  });
  it('holds the selection on version conflict and requires fresh content then explicit acknowledgement', async () => {
    mock.review.mockRejectedValueOnce(new ApiError({ code: 'VERSION_CONFLICT', message: '记录版本已变化' }, 409));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />); await screen.findByRole('article');
    chooseShare(); fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('调整分享范围')).toHaveValue('parent_shareable');
    expect(screen.getByLabelText('调整分享范围')).toBeDisabled();
    const latest = record({ summary: '另一客户端更新后的内容', updatedAt: '2026-09-16T03:00:00.000Z' });
    mock.list.mockResolvedValue({ items: [latest], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: '刷新并核对记录' }));
    await screen.findByText('另一客户端更新后的内容');
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '已核对，保留选择继续' }));
    mock.review.mockResolvedValue({ ...latest, visibility: 'parent_shareable', updatedAt: '2026-09-16T04:00:00.000Z' });
    fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    await screen.findByText(/已保存。分享范围/);
    expect(mock.review.mock.calls[1][5]).toBe(latest.updatedAt);
  });
  it('reconciles a lost response and never resends an already applied change', async () => {
    mock.review.mockRejectedValueOnce(new Error('网络断开'));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />); await screen.findByRole('article');
    chooseShare(); fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    await screen.findByText(/不能直接重复保存/);
    mock.list.mockResolvedValue({ items: [record({ visibility: 'parent_shareable', updatedAt: '2026-09-16T03:00:00.000Z' })], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: '刷新并核对记录' }));
    fireEvent.click(await screen.findByRole('button', { name: '已核对，保留选择继续' }));
    await screen.findByText('当前记录已是所选状态，无需重复保存。');
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled(); expect(mock.review).toHaveBeenCalledTimes(1);
  });
  it('holds recovery when reconciliation fails', async () => {
    mock.review.mockRejectedValue(new Error('丢回执'));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />); await screen.findByRole('article');
    chooseShare(); fireEvent.click(screen.getByRole('button', { name: '保存分享范围' })); await screen.findByRole('alert');
    mock.list.mockRejectedValue(new Error('读取仍失败'));
    fireEvent.click(screen.getByRole('button', { name: '刷新并核对记录' }));
    await screen.findByText(/未能读取这条记录的最新状态/);
    expect(screen.queryByRole('button', { name: '已核对，保留选择继续' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('调整分享范围')).toHaveValue('parent_shareable'); expect(mock.review).toHaveBeenCalledTimes(1);
  });
  it('ignores a late save after switching teacher and student', async () => {
    const late = deferred<ReturnType<typeof record>>(); mock.review.mockReturnValueOnce(late.promise);
    const changed = vi.fn();
    const view = render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" onRecordsChanged={changed} />);
    await screen.findByRole('article'); chooseShare(); fireEvent.click(screen.getByRole('button', { name: '保存分享范围' }));
    mock.list.mockResolvedValue({ items: [record({ teacherId: 'teacher-b', studentId: 's2', summary: '乙教师记录' })], total: 1 });
    view.rerender(<StudentRecordPanel teacherId="teacher-b" studentId="s2" onRecordsChanged={changed} />); await screen.findByText('乙教师记录');
    await act(async () => late.resolve(record({ visibility: 'parent_shareable' })));
    expect(screen.getByLabelText('调整分享范围')).toHaveValue('internal_only'); expect(changed).not.toHaveBeenCalled();
  });
  it('requires acknowledgement when external refresh changes a record with unsaved selection', async () => {
    const view = render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" refreshToken={1} />); await screen.findByRole('article'); chooseShare();
    mock.list.mockResolvedValue({ items: [record({ summary: '外部修订', updatedAt: '2026-09-16T04:00:00.000Z' })], total: 1 });
    view.rerender(<StudentRecordPanel teacherId="teacher-a" studentId="s1" refreshToken={2} />);
    await screen.findByText('外部修订'); await screen.findByText(/记录已有更新/);
    expect(screen.getByRole('button', { name: '保存分享范围' })).toBeDisabled(); expect(screen.getByLabelText('调整分享范围')).toHaveValue('parent_shareable');
  });
  it('does not report success for a wrong-owner receipt and leaves superseded records read-only', async () => {
    mock.review.mockResolvedValue(record({ teacherId: 'teacher-b', visibility: 'parent_shareable' }));
    render(<StudentRecordPanel teacherId="teacher-a" studentId="s1" />); await screen.findByRole('article'); chooseShare();
    fireEvent.click(screen.getByRole('button', { name: '保存分享范围' })); await screen.findByText(/保存回执无法核对/);
    mock.list.mockResolvedValue({ items: [record({ reviewStatus: 'superseded', updatedAt: '2026-09-16T04:00:00.000Z' })], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: '刷新并核对记录' }));
    await waitFor(() => expect(screen.queryByLabelText('调整分享范围')).not.toBeInTheDocument());
    expect(mock.review).toHaveBeenCalledTimes(1);
  });
});
