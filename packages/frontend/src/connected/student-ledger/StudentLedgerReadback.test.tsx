import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentLedgerReadback } from './StudentLedgerReadback';
import type { LessonBalance, LessonLedgerEntryData, PrepareLessonLedgerAdjustmentResult } from '../../api/types';

const mock = vi.hoisted(() => ({ balance: vi.fn(), entries: vi.fn(), prepare: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api/students', () => ({ getStudentBalance: mock.balance }));
vi.mock('../../api/payments', () => ({
  listLessonLedgerEntries: mock.entries,
  prepareLessonLedgerAdjustment: mock.prepare,
  confirmLessonLedgerAdjustment: mock.confirm,
}));

const balance = (overrides: Partial<LessonBalance> = {}): LessonBalance => ({ purchased: 10, attended: 2, adjustments: 1, remaining: 9, ...overrides });
const entry = (overrides: Partial<LessonLedgerEntryData> = {}): LessonLedgerEntryData => ({
  id: 'entry-1', teacherId: 'teacher-a', studentId: 's1', entryType: 'purchase', lessonDelta: 5,
  amount: null, reason: '春季课程包', paymentId: 'payment-1', lessonId: null,
  adjustmentConfirmationId: null, clientRequestId: null, createdAt: '2026-09-20T01:00:00.000Z',
  ...overrides,
});

const preview = (overrides: Partial<PrepareLessonLedgerAdjustmentResult> = {}): PrepareLessonLedgerAdjustmentResult => ({
  confirmation: {
    id: 'confirmation-1', teacherId: 'teacher-a', studentId: 's1', entryType: 'gift', lessonDelta: 2,
    reason: '续课赠送', clientRequestId: 'ledger-request-1', status: 'pending', confirmedAt: null,
    createdAt: '2026-09-23T01:00:00.000Z', updatedAt: '2026-09-23T01:00:00.000Z', entry: null,
  },
  balanceBefore: balance({ remaining: 9 }),
  balanceAfter: balance({ adjustments: 3, remaining: 11 }),
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mock.balance.mockResolvedValue(balance());
  mock.entries.mockResolvedValue([]);
  mock.prepare.mockImplementation(async (_teacherId, body) => preview({
    confirmation: { ...preview().confirmation, entryType: body.entryType, lessonDelta: body.lessonDelta, reason: body.reason, clientRequestId: body.clientRequestId },
  }));
  mock.confirm.mockResolvedValue({ confirmation: { ...preview().confirmation, status: 'confirmed' }, balance: preview().balanceAfter });
});

describe('StudentLedgerReadback', () => {
  it('reads and presents the four balances and business ledger labels', async () => {
    mock.balance.mockResolvedValue(balance({ purchased: 12, attended: 3, adjustments: 2, remaining: 11 }));
    mock.entries.mockResolvedValue([
      entry({ id: 'purchase', entryType: 'purchase', lessonDelta: 12, amount: 1200 }),
      entry({ id: 'deduction', entryType: 'attendance_deduction', lessonDelta: -1, reason: '完成课次扣除' }),
      entry({ id: 'gift', entryType: 'gift', lessonDelta: 2, reason: '续课赠送' }),
    ]);
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    expect(await screen.findByText('当前剩余')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('已消耗')).toBeInTheDocument();
    expect(screen.getByText('购课')).toBeInTheDocument();
    expect(screen.getByText('上课扣除')).toBeInTheDocument();
    expect(screen.getAllByText('赠课')).toHaveLength(2);
    expect(screen.getByText('+12 课时')).toBeInTheDocument();
    expect(screen.getByText('-1 课时')).toBeInTheDocument();
    expect(screen.getAllByText('2026年9月20日 09:00')).toHaveLength(3);
    expect(mock.entries).toHaveBeenCalledWith('teacher-a', { studentId: 's1' });
  });

  it('shows an explicit empty state', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    expect(await screen.findByText('暂无课时流水记录')).toBeInTheDocument();
  });

  it('shows failure without fabricated data and retries successfully', async () => {
    mock.balance.mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValue(balance({ remaining: 7 }));
    mock.entries.mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValue([entry()]);
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂不可用');
    expect(screen.queryByText('当前剩余')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('当前剩余')).toBeInTheDocument();
    expect(mock.balance).toHaveBeenCalledTimes(2);
  });

  it('discards a late response from the former student scope', async () => {
    let resolveOld!: (value: LessonBalance) => void;
    let resolveOldEntries!: (value: LessonLedgerEntryData[]) => void;
    const oldBalance = new Promise<LessonBalance>((resolve) => { resolveOld = resolve; });
    const oldEntries = new Promise<LessonLedgerEntryData[]>((resolve) => { resolveOldEntries = resolve; });
    mock.balance.mockReturnValueOnce(oldBalance);
    mock.entries.mockReturnValueOnce(oldEntries);
    const view = render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    mock.balance.mockResolvedValue(balance({ remaining: 4 }));
    mock.entries.mockResolvedValue([entry({ id: 'new', studentId: 's2', reason: '新学生流水' })]);
    view.rerender(<StudentLedgerReadback teacherId="teacher-a" studentId="s2" />);
    expect(await screen.findByText('新学生流水')).toBeInTheDocument();
    await act(async () => {
      resolveOld(balance({ remaining: 999 }));
      resolveOldEntries([entry({ id: 'old', reason: '旧学生迟到流水' })]);
    });
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    expect(screen.queryByText('旧学生迟到流水')).not.toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('requires a positive quantity and reason before creating a preview', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('正整数课时和调整原因');
    expect(mock.prepare).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2147483648' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '超出整数范围' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    expect(screen.getByLabelText('课时数量')).toBeInvalid();
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('treats a confirmed prepare replay as completed and never offers a second confirmation', async () => {
    const onLedgerChanged = vi.fn().mockResolvedValue(undefined);
    mock.balance.mockResolvedValueOnce(balance({ remaining: 9 })).mockResolvedValueOnce(balance({ adjustments: 3, remaining: 11 }));
    mock.entries.mockResolvedValueOnce([]).mockResolvedValueOnce([entry({ id: 'gift-entry', entryType: 'gift', lessonDelta: 2, reason: '续课赠送' })]);
    mock.prepare.mockResolvedValue(preview({
      confirmation: {
        ...preview().confirmation,
        status: 'confirmed',
        confirmedAt: '2026-09-23T01:01:00.000Z',
        entry: entry({ id: 'gift-entry', entryType: 'gift', lessonDelta: 2, reason: '续课赠送' }),
      },
      balanceBefore: balance({ adjustments: 3, remaining: 11 }),
      balanceAfter: balance({ adjustments: 3, remaining: 11 }),
    }));
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" onLedgerChanged={onLedgerChanged} />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));

    expect(await screen.findByText('该调整已经确认写入流水，余额和流水已从服务端更新。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认写入流水' })).not.toBeInTheDocument();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(onLedgerChanged).toHaveBeenCalledTimes(1);
    expect(mock.balance).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('课时余额汇总')).toHaveTextContent('当前剩余11课时');
  });

  it('maps gift, refund and manual adjustment directions to signed payloads and keeps the displayed balance authoritative before confirmation', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');

    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    expect(mock.prepare).toHaveBeenLastCalledWith('teacher-a', expect.objectContaining({ entryType: 'gift', lessonDelta: 2, reason: '续课赠送' }));
    expect(screen.getByLabelText('课时余额汇总')).toHaveTextContent('当前剩余9课时');
    expect(mock.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.click(screen.getByLabelText('退款记录'));
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await waitFor(() => expect(mock.prepare).toHaveBeenLastCalledWith('teacher-a', expect.objectContaining({ entryType: 'refund', lessonDelta: -2 })));
    expect(screen.getByText('仅用于对账记录，不代表平台已实际退款。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.click(screen.getByLabelText('人工调整'));
    fireEvent.click(screen.getByLabelText('扣减课时'));
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await waitFor(() => expect(mock.prepare).toHaveBeenLastCalledWith('teacher-a', expect.objectContaining({ entryType: 'manual_adjustment', lessonDelta: -2 })));
  });

  it('only confirms after the explicit second action, then refreshes balance and ledger from the server', async () => {
    let resolveWorkspaceReload!: () => void;
    const onLedgerChanged = vi.fn(() => new Promise<void>((resolve) => { resolveWorkspaceReload = resolve; }));
    mock.balance.mockResolvedValueOnce(balance({ remaining: 9 })).mockResolvedValueOnce(balance({ adjustments: 3, remaining: 11 }));
    mock.entries.mockResolvedValueOnce([]).mockResolvedValueOnce([entry({ id: 'gift-entry', entryType: 'gift', lessonDelta: 2, reason: '续课赠送' })]);
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" onLedgerChanged={onLedgerChanged} />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    expect(mock.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认写入流水' }));
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledWith('teacher-a', 'confirmation-1'));
    await waitFor(() => expect(onLedgerChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '正在更新账户…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消调整' })).toBeDisabled();
    expect(screen.getByLabelText('课时数量')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '正在更新账户…' }));
    expect(mock.prepare).toHaveBeenCalledTimes(1);
    await act(async () => { resolveWorkspaceReload(); });
    expect((await screen.findAllByText('赠课')).length).toBeGreaterThan(1);
    await waitFor(() => expect(mock.entries).toHaveBeenCalledTimes(2));
    expect(onLedgerChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('课时余额汇总')).toHaveTextContent('当前剩余11课时');
  });

  it('preserves the preview and replays an identical prepare payload after a transient prepare failure', async () => {
    mock.prepare.mockRejectedValueOnce(new Error('网络短暂中断')).mockResolvedValueOnce(preview());
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络短暂中断');
    const first = mock.prepare.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    expect(mock.prepare.mock.calls[1][1]).toEqual(first);
  });

  it('uses a new request key after an accepted preview is returned to edit', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    const first = mock.prepare.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '改为补课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await waitFor(() => expect(mock.prepare).toHaveBeenCalledTimes(2));
    expect(mock.prepare.mock.calls[1][1]).toEqual(expect.objectContaining({ reason: '改为补课赠送' }));
    expect(mock.prepare.mock.calls[1][1].clientRequestId).not.toBe(first.clientRequestId);
  });

  it('drops a local preview when authoritative account data is refreshed', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认写入流水' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '查看影响' })).toBeInTheDocument();
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it('does not restore a stale prepare response after parent data refreshes', async () => {
    let resolvePrepare!: (value: PrepareLessonLedgerAdjustmentResult) => void;
    mock.prepare.mockImplementationOnce(() => new Promise<PrepareLessonLedgerAdjustmentResult>((resolve) => { resolvePrepare = resolve; }));
    const view = render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" refreshToken="first" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    expect(screen.getByRole('button', { name: '正在查看影响…' })).toBeDisabled();

    view.rerender(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" refreshToken="second" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '查看影响' })).toBeEnabled());
    await act(async () => { resolvePrepare(preview()); });
    expect(screen.queryByRole('button', { name: '确认写入流水' })).not.toBeInTheDocument();
  });

  it('keeps the preview, input and confirmation id after a confirm failure so it can be retried', async () => {
    mock.confirm.mockRejectedValueOnce(new Error('确认服务暂不可用'));
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '续课赠送' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    fireEvent.click(screen.getByRole('button', { name: '确认写入流水' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('确认服务暂不可用');
    expect(screen.getByText('请确认本次课时调整')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认写入流水' }));
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledTimes(2));
    expect(mock.confirm.mock.calls[1]).toEqual(mock.confirm.mock.calls[0]);
  });

  it('cancels a pending adjustment without confirming it', async () => {
    render(<StudentLedgerReadback teacherId="teacher-a" studentId="s1" />);
    await screen.findByText('当前剩余');
    fireEvent.change(screen.getByLabelText('课时数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '暂不调整' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响' }));
    await screen.findByText('请确认本次课时调整');
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.click(screen.getByRole('button', { name: '取消调整' }));
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('课时数量')).toHaveValue(null);
    expect(screen.getByLabelText('调整原因')).toHaveValue('');
    expect(screen.getByLabelText('课时余额汇总')).toHaveTextContent('当前剩余9课时');
  });
});
