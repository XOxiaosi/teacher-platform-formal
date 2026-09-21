import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureInbox } from './CaptureInbox';
import { CandidateCard } from './CandidateCard';
import { clearCaptureDrafts } from './drafts';
import type { CaptureRecord } from '../../api/captures';
const mock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), edit: vi.fn(), review: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api/captures', () => ({ listCaptures: mock.list, getCapture: mock.get, editCaptureCandidate: mock.edit, reviewCaptureCandidate: mock.review, confirmCaptureCandidate: mock.confirm }));
const students = [{ id: 's1', name: '小雨', grade: '五年级' }, { id: 's2', name: '小雨', grade: '初一' }];
const record = (): CaptureRecord => {
  const candidate = { id: 'c1', candidateType: 'verbatim_note' as const, payload: { text: '今天主动订正' }, originalPayload: { text: '今天主动订正' }, reviewStatus: 'pending' as const, version: 1, confidence: null };
  return { id: 'e1', rawText: '今天主动订正，家长提到睡眠不足', sourceType: 'text', sourceChannel: 'web', occurredAt: '2026-09-16T00:00:00Z', createdAt: '2026-09-16T00:00:00Z', task: { id: 't1', status: 'pending', processorVersion: 'manual-v1' }, candidate, candidates: [candidate, { ...candidate, id: 'c2', payload: { text: '家长提到睡眠不足' } }] };
};
beforeEach(() => { clearCaptureDrafts('teacher-a'); sessionStorage.clear(); vi.resetAllMocks(); mock.list.mockResolvedValue({ items: [record()], nextCursor: null }); mock.get.mockResolvedValue(record()); });
describe('persistent material inbox', () => {
  it('refreshes parent records once after a confirmed candidate and not during initial loading', async () => {
    const onRecordsChanged = vi.fn().mockResolvedValue(undefined);
    render(<CaptureInbox teacherId="teacher-a" students={students} onRecordsChanged={onRecordsChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /今天主动订正/ }));
    expect(await screen.findByText('提交时间：2026年9月16日 08:00（北京时间）')).toBeInTheDocument();
    const first = within((await screen.findAllByRole('article'))[0]);
    expect(onRecordsChanged).not.toHaveBeenCalled();
    fireEvent.change(first.getByLabelText('归入学生'), { target: { value: 's1' } });
    mock.confirm.mockResolvedValue({ recordId: 'r1', studentId: 's1' });
    fireEvent.click(first.getByRole('button', { name: '确认归入档案' }));
    await waitFor(() => expect(onRecordsChanged).toHaveBeenCalledTimes(1));
    expect(mock.list).toHaveBeenCalledTimes(2);
    expect(first.getByText('已保存', { selector: 'strong' })).toBeInTheDocument();
    expect(first.getByRole('link', { name: '基于这条记录整理家长反馈' })).toHaveAttribute('href', '#/feedback?studentId=s1&recordId=r1');
  });
  it('does not notify parent records when candidate confirmation fails', async () => {
    const onRecordsChanged = vi.fn().mockResolvedValue(undefined);
    mock.confirm.mockRejectedValue(new Error('确认响应失败'));
    render(<CaptureInbox teacherId="teacher-a" students={students} onRecordsChanged={onRecordsChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /今天主动订正/ }));
    const first = within((await screen.findAllByRole('article'))[0]);
    fireEvent.change(first.getByLabelText('归入学生'), { target: { value: 's1' } });
    fireEvent.click(first.getByRole('button', { name: '确认归入档案' }));
    await first.findByText('确认响应失败');
    expect(onRecordsChanged).not.toHaveBeenCalled();
    expect(mock.list).toHaveBeenCalledTimes(1);
  });
  it('keeps a saved confirmation locked when the parent records refresh fails', async () => {
    const onRecordsChanged = vi.fn().mockRejectedValue(new Error('档案刷新失败'));
    mock.confirm.mockResolvedValue({ recordId: 'r1', studentId: 's1' });
    render(<CaptureInbox teacherId="teacher-a" students={students} onRecordsChanged={onRecordsChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /今天主动订正/ }));
    const first = within((await screen.findAllByRole('article'))[0]);
    fireEvent.change(first.getByLabelText('归入学生'), { target: { value: 's1' } });
    fireEvent.click(first.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText(/操作已保存，学生档案暂未刷新/);
    expect(first.getByText('已保存', { selector: 'strong' })).toBeInTheDocument();
    expect(first.queryByRole('button', { name: '确认归入档案' })).not.toBeInTheDocument();
    expect(first.queryByRole('button', { name: '重试本次确认' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新材料' }));
    await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(3));
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    expect(onRecordsChanged).toHaveBeenCalledTimes(1);
  });

  it('loads every page and opens original text with independent candidates', async () => {
    mock.list.mockResolvedValueOnce({ items: [], nextCursor: 'next' }).mockResolvedValueOnce({ items: [record()], nextCursor: null });
    render(<CaptureInbox teacherId="teacher-a" students={students} />);
    fireEvent.click(await screen.findByRole('button', { name: /今天主动订正/ }));
    await screen.findByRole('heading', { name: '原始内容' });
    expect(mock.list.mock.calls.map((args) => args[0])).toEqual([undefined, 'next']);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    const first = screen.getAllByRole('article')[0];
    expect(within(first).getByRole('button', { name: '确认归入档案' })).toBeDisabled();
    fireEvent.change(within(first).getByLabelText('归入学生'), { target: { value: 's2' } });
    mock.confirm.mockResolvedValue({ recordId: 'r1', studentId: 's2' });
    fireEvent.click(within(first).getByRole('button', { name: '确认归入档案' }));
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledWith('e1', 'c1', expect.objectContaining({ studentId: 's2', version: 1 })));
    expect(mock.confirm).toHaveBeenCalledTimes(1);
  });
  it('keeps changed input when editing fails and never confirms unsaved changes', async () => {
    mock.edit.mockRejectedValue(new Error('版本已变化，请重新核对'));
    render(<CandidateCard teacherId="teacher-a" captureId="e1" item={record().candidate} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('拟保存内容'), { target: { value: '教师核对后的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }));
    await screen.findByRole('alert'); expect(screen.getByLabelText('拟保存内容')).toHaveValue('教师核对后的内容');
    expect(screen.getByRole('button', { name: '确认归入档案' })).toBeDisabled();
  });
  it('retries ambiguous confirmation with the identical request and locks changes', async () => {
    mock.confirm.mockRejectedValueOnce(new Error('响应中断')).mockResolvedValueOnce({ recordId: 'r1', studentId: 's1' });
    render(<CandidateCard teacherId="teacher-a" captureId="e1" item={record().candidate} students={students} onChange={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByRole('alert'); expect(screen.getByLabelText('归入学生')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }));
    await screen.findByText('已保存'); expect(mock.confirm.mock.calls[1]).toEqual(mock.confirm.mock.calls[0]);
  });
  it('does not create a formal record on defer and restores deferred items on remount', async () => {
    const data = record(); data.candidates![0].reviewStatus = 'deferred';
    mock.review.mockResolvedValue(data); mock.list.mockResolvedValue({ items: [data], nextCursor: null }); mock.get.mockResolvedValue(data);
    const first = render(<CandidateCard teacherId="teacher-a" captureId="e1" item={record().candidate} students={students} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '暂留' }));
    await waitFor(() => expect(mock.review).toHaveBeenCalledWith('e1', 'c1', { version: 1, action: 'defer' }));
    expect(mock.confirm).not.toHaveBeenCalled(); first.unmount();
    render(<CaptureInbox teacherId="teacher-a" students={students} />); fireEvent.click(await screen.findByRole('button', { name: /今天主动订正/ }));
    await screen.findByText('暂留', { selector: 'strong' });
  });
  it('does not present network failure as an empty inbox', async () => {
    mock.list.mockRejectedValue(new Error('材料服务不可达')); render(<CaptureInbox teacherId="teacher-a" students={students} />);
    await screen.findByRole('alert'); expect(screen.queryByText(/还没有已提交材料/)).not.toBeInTheDocument();
  });
});
