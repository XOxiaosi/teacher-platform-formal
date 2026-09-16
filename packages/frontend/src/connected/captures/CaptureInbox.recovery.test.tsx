import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureInbox } from './CaptureInbox';
import { CandidateCard } from './CandidateCard';
import { clearCaptureDrafts, readCaptureDraft, writeCaptureDraft } from './drafts';
import type { CaptureCandidate, CaptureRecord } from '../../api/captures';
import { ApiError } from '../../api/client';

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), edit: vi.fn(), review: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api/captures', () => ({ listCaptures: api.list, getCapture: api.get, editCaptureCandidate: api.edit, reviewCaptureCandidate: api.review, confirmCaptureCandidate: api.confirm }));
const students = [{ id: 'student-a', name: '小雨', grade: '五年级' }, { id: 'student-b', name: '小雨', grade: '初一' }];
const candidate = (overrides: Partial<CaptureCandidate> = {}): CaptureCandidate => ({ id: 'candidate-1', candidateType: 'verbatim_note', payload: { text: '原始候选' }, originalPayload: { text: '原始候选' }, reviewStatus: 'pending', version: 1, confidence: null, ...overrides });
function material(id: string, item = candidate()): CaptureRecord {
  return { id, sourceType: 'text', sourceChannel: 'web', rawText: `材料 ${id}`, occurredAt: '2026-09-16T00:00:00Z', createdAt: '2026-09-16T00:00:00Z', task: { id: `task-${id}`, status: 'completed', processorVersion: 'manual-candidates-v1' }, candidate: item, candidates: [item] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks(); clearCaptureDrafts('teacher-a'); clearCaptureDrafts('teacher-b'); sessionStorage.clear();
  api.list.mockResolvedValue({ items: [material('one'), material('two')], nextCursor: null });
  api.get.mockImplementation(async (id: string) => material(id));
});

describe('candidate drafts and confirmation recovery in synthetic sessions', () => {
  it.each([
    { status: 400, code: 'VALIDATION_ERROR' as const },
    { status: 404, code: 'NOT_FOUND' as const },
    { status: 409, code: 'VERSION_CONFLICT' as const },
  ])('allows correcting a first-attempt $status rejection and selecting a different student', async ({ status, code }) => {
    api.confirm.mockRejectedValueOnce(new ApiError({ code, message: '学生不存在或确认未通过校验' }, status))
      .mockResolvedValueOnce({ recordId: 'record-b', studentId: 'student-b', scheduleId: null });
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('学生不存在或确认未通过校验');
    expect(screen.getByLabelText('拟保存内容')).toHaveValue('原始候选');
    expect(screen.getByLabelText('拟保存内容')).toBeEnabled();
    expect(screen.getByLabelText('归入学生')).toBeEnabled();
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')?.pendingConfirm).toBeUndefined();
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-b' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('已保存', { selector: 'strong' });
    expect(api.confirm.mock.calls[1][2].studentId).toBe('student-b');
    expect(api.confirm.mock.calls[1][2].clientRequestId).not.toBe(api.confirm.mock.calls[0][2].clientRequestId);
  });

  it('keeps the original confirmation immutable when a network failure is followed by an explicit 404', async () => {
    api.confirm.mockRejectedValueOnce(new Error('回执丢失'))
      .mockRejectedValueOnce(new ApiError({ code: 'NOT_FOUND', message: '学生不存在' }, 404));
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('回执丢失');
    fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }));
    await screen.findByText('学生不存在');
    expect(api.confirm.mock.calls[1]).toEqual(api.confirm.mock.calls[0]);
    expect(screen.getByLabelText('归入学生')).toBeDisabled();
    expect(screen.getByLabelText('拟保存内容')).toBeDisabled();
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')?.pendingConfirm).toEqual(api.confirm.mock.calls[0][2]);
  });

  it('does not let a late first-attempt rejection unlock a confirmation already retried by a reopened card', async () => {
    const initial = deferred<{ recordId: string; studentId: string; scheduleId: null }>();
    api.confirm.mockReturnValueOnce(initial.promise).mockRejectedValueOnce(new Error('重试回执丢失'));
    const first = render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' })); first.unmount();
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }));
    await screen.findByText('重试回执丢失');
    await act(async () => initial.reject(new ApiError({ code: 'NOT_FOUND', message: '首次学生不存在' }, 404)));
    expect(screen.getByLabelText('归入学生')).toBeDisabled();
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')?.pendingConfirm).toEqual(api.confirm.mock.calls[0][2]);
  });

  it('does not ask for another review when a successful confirmation increments the server version', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    api.confirm.mockResolvedValue({ recordId: 'saved-once', studentId: 'student-a', scheduleId: null });
    const view = render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('已保存', { selector: 'strong' });
    view.rerender(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate({ version: 2, reviewStatus: 'confirmed', confirmedRecordId: 'saved-once' })} students={students} onChange={onChange} />);
    expect(screen.queryByLabelText('候选变化')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认归入档案' })).not.toBeInTheDocument();
  });

  it('keeps text and the chosen student across material switches, refresh and remount', async () => {
    const first = render(<CaptureInbox teacherId="teacher-a" students={students} />);
    fireEvent.click(await screen.findByRole('button', { name: /材料 one/ }));
    fireEvent.change(await screen.findByLabelText('拟保存内容'), { target: { value: '教师尚未保存的修改' } });
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-b' } });
    fireEvent.click(screen.getByRole('button', { name: /材料 two/ }));
    await waitFor(() => expect(screen.getByLabelText('拟保存内容')).toHaveValue('原始候选'));
    fireEvent.click(screen.getByRole('button', { name: /材料 one/ }));
    await waitFor(() => expect(screen.getByLabelText('拟保存内容')).toHaveValue('教师尚未保存的修改'));
    fireEvent.click(screen.getByRole('button', { name: '刷新材料' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新材料' })).toBeEnabled());
    expect(screen.getByLabelText('拟保存内容')).toHaveValue('教师尚未保存的修改');
    expect(screen.getByLabelText('归入学生')).toHaveValue('student-b');
    first.unmount();
    render(<CaptureInbox teacherId="teacher-a" students={students} />);
    fireEvent.click(await screen.findByRole('button', { name: /材料 one/ }));
    expect(await screen.findByLabelText('拟保存内容')).toHaveValue('教师尚未保存的修改');
    expect(screen.getByLabelText('归入学生')).toHaveValue('student-b');
    expect(api.edit).not.toHaveBeenCalled(); expect(api.confirm).not.toHaveBeenCalled();
  });

  it('preserves local edits on a newer server version and requires explicit review before saving them', async () => {
    const view = render(<CaptureInbox teacherId="teacher-a" students={students} />);
    fireEvent.click(await screen.findByRole('button', { name: /材料 one/ }));
    fireEvent.change(await screen.findByLabelText('拟保存内容'), { target: { value: '我的核对修改' } });
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-b' } });
    const newer = material('one', candidate({ version: 2, payload: { text: '另一端更新后的候选' } }));
    api.list.mockResolvedValue({ items: [newer], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: '刷新材料' }));
    await screen.findByText('最新候选：另一端更新后的候选');
    expect(screen.getByLabelText('拟保存内容')).toHaveValue('我的核对修改');
    expect(screen.getByRole('button', { name: '保存候选修改' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '确认归入档案' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保留输入，按最新版本重新核对' }));
    const edited = material('one', candidate({ version: 3, payload: { text: '我的核对修改' } }));
    api.edit.mockResolvedValue(edited); api.list.mockResolvedValue({ items: [edited], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: '保存候选修改' }));
    await waitFor(() => expect(api.edit).toHaveBeenCalledWith('one', 'candidate-1', { version: 2, text: '我的核对修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认归入档案' })).toBeEnabled());
    expect(screen.getByLabelText('归入学生')).toHaveValue('student-b');
    api.confirm.mockResolvedValue({ recordId: 'record-1', studentId: 'student-b', scheduleId: null });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('已保存', { selector: 'strong' });
    expect(api.confirm).toHaveBeenCalledWith('one', 'candidate-1', expect.objectContaining({ version: 3, studentId: 'student-b' }));
    view.unmount();
  });

  it('replays the original confirmation identity and student after the server commits but its response is lost', async () => {
    const accepted = new Map<string, { studentId: string; version: number }>();
    api.confirm.mockImplementation(async (_capture, _candidate, body) => {
      if (!accepted.has(body.clientRequestId)) { accepted.set(body.clientRequestId, { studentId: body.studentId, version: body.version }); throw new Error('响应丢失'); }
      expect(accepted.get(body.clientRequestId)).toEqual({ studentId: body.studentId, version: body.version });
      return { recordId: 'saved-once', studentId: body.studentId, scheduleId: null };
    });
    const first = render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText('响应丢失');
    const original = api.confirm.mock.calls[0];
    first.unmount();
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByLabelText('归入学生')).toBeDisabled();
    expect(screen.getByLabelText('归入学生')).toHaveValue('student-a');
    expect(screen.getByLabelText('拟保存内容')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试本次确认' }));
    await screen.findByText('已保存', { selector: 'strong' });
    expect(api.confirm.mock.calls[1]).toEqual(original); expect(accepted.size).toBe(1);
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')?.confirmedRecordId).toBe('saved-once');
  });

  it('updates a reopened card from a late successful receipt without creating a second confirmation', async () => {
    const receipt = deferred<{ recordId: string; studentId: string; scheduleId: null }>(); api.confirm.mockReturnValue(receipt.promise);
    const first = render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' })); first.unmount();
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '重试本次确认' })).toBeInTheDocument();
    await act(async () => receipt.resolve({ recordId: 'saved-once', studentId: 'student-a', scheduleId: null }));
    await screen.findByText('已保存', { selector: 'strong' });
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a confirmation receipt belonging to another student', async () => {
    api.confirm.mockResolvedValue({ recordId: 'wrong-record', studentId: 'student-b', scheduleId: null });
    render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    await screen.findByText(/尚未取得与本次确认匹配的保存回执/);
    expect(screen.queryByText('已保存', { selector: 'strong' })).not.toBeInTheDocument();
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')?.pendingConfirm?.studentId).toBe('student-a');
  });

  it('clears only the logged-out teacher and fences a late confirmation from recreating that draft', async () => {
    const receipt = deferred<{ recordId: string; studentId: string; scheduleId: null }>(); api.confirm.mockReturnValue(receipt.promise);
    const first = render(<CandidateCard teacherId="teacher-a" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('归入学生'), { target: { value: 'student-a' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归入档案' }));
    writeCaptureDraft('teacher-b', 'one', 'candidate-1', { generation: 'other-generation', text: '乙的独立草稿', studentId: 'student-b', baseVersion: 1 });
    clearCaptureDrafts('teacher-a'); first.unmount();
    const other = render(<CandidateCard teacherId="teacher-b" captureId="one" item={candidate()} students={students} onChange={vi.fn()} />);
    await act(async () => receipt.resolve({ recordId: 'teacher-a-result', studentId: 'student-a', scheduleId: null }));
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')).toBeUndefined();
    expect(within(other.container).getByLabelText('拟保存内容')).toHaveValue('乙的独立草稿');
    expect(screen.queryByText('已保存', { selector: 'strong' })).not.toBeInTheDocument();
    expect(JSON.stringify(sessionStorage)).not.toContain('teacher-a-result');
    expect(JSON.stringify(localStorage)).not.toContain('乙的独立草稿');
  });

  it('remounts inbox state on account change and does not retain the previous teacher selection', async () => {
    const view = render(<CaptureInbox teacherId="teacher-a" students={students} />);
    fireEvent.click(await screen.findByRole('button', { name: /材料 one/ }));
    fireEvent.change(await screen.findByLabelText('拟保存内容'), { target: { value: '甲的私人编辑' } });
    view.rerender(<CaptureInbox teacherId="teacher-b" students={students} />);
    expect(screen.queryByLabelText('拟保存内容')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /材料 one/ }));
    expect(await screen.findByLabelText('拟保存内容')).toHaveValue('原始候选');
    expect(readCaptureDraft('teacher-a', 'one', 'candidate-1')).toBeUndefined();
  });
});
