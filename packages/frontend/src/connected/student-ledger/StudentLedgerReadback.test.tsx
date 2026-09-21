import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentLedgerReadback } from './StudentLedgerReadback';
import type { LessonBalance, LessonLedgerEntryData } from '../../api/types';

const mock = vi.hoisted(() => ({ balance: vi.fn(), entries: vi.fn() }));
vi.mock('../../api/students', () => ({ getStudentBalance: mock.balance }));
vi.mock('../../api/payments', () => ({ listLessonLedgerEntries: mock.entries }));

const balance = (overrides: Partial<LessonBalance> = {}): LessonBalance => ({ purchased: 10, attended: 2, adjustments: 1, remaining: 9, ...overrides });
const entry = (overrides: Partial<LessonLedgerEntryData> = {}): LessonLedgerEntryData => ({
  id: 'entry-1', teacherId: 'teacher-a', studentId: 's1', entryType: 'purchase', lessonDelta: 5,
  amount: null, reason: '春季课程包', paymentId: 'payment-1', lessonId: null,
  adjustmentConfirmationId: null, clientRequestId: null, createdAt: '2026-09-20T01:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mock.balance.mockResolvedValue(balance());
  mock.entries.mockResolvedValue([]);
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
    expect(screen.getByText('赠课')).toBeInTheDocument();
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
});
