import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsPage } from './PaymentsPage';
import * as paymentsApi from '../../api/payments';
import * as studentsApi from '../../api/students';
import type { StudentData } from '../../api/types';

vi.mock('../../api/payments');
vi.mock('../../api/students');

const baseStudent: StudentData = {
  id: 'student-2',
  teacherId: 'demo-teacher',
  name: '李四',
  grade: '高一',
  source: null,
  currentStatus: 'active',
  stageGoal: null,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
};

const basePayment = {
  id: 'payment-1',
  teacherId: 'demo-teacher',
  studentId: 'student-1',
  amount: 1200,
  lessonCount: 10,
  paidAt: '2026-07-01',
  note: '暑期班',
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(paymentsApi.listPayments).mockResolvedValue({ items: [basePayment], total: 1 });
  vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [baseStudent], total: 1 });
  vi.mocked(studentsApi.getStudentBalance).mockResolvedValue({ purchased: 12, attended: 5, remaining: 7 });
  vi.mocked(paymentsApi.createPayment).mockResolvedValue({
    ...basePayment,
    id: 'payment-2',
    studentId: 'student-2',
    amount: 800,
    lessonCount: 8,
    paidAt: '2026-07-09',
    note: '补课包',
  });
});

describe('PaymentsPage', () => {
  it('加载并展示缴费列表和学生选项', async () => {
    render(<PaymentsPage teacherId="demo-teacher" />);

    expect(screen.getByText('正在加载缴费记录')).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: '缴费课时' })).toBeInTheDocument();
    expect(screen.getAllByText('学生').length).toBeGreaterThan(0);
    expect(screen.getByText('金额')).toBeInTheDocument();
    expect(screen.getAllByText('购买课时').length).toBeGreaterThan(0);
    expect(screen.getAllByText('缴费日期').length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: '李四 · 高一' })).toBeInTheDocument();
    expect(screen.getByText('student-1')).toBeInTheDocument();
    expect(screen.getByText('¥1,200')).toBeInTheDocument();
    expect(screen.getByText('10 课时')).toBeInTheDocument();
    expect(screen.getByText('2026年7月1日')).toBeInTheDocument();
    expect(studentsApi.listStudents).toHaveBeenCalledWith('demo-teacher');
  });

  it('空数据展示空状态', async () => {
    vi.mocked(paymentsApi.listPayments).mockResolvedValue({ items: [], total: 0 });

    render(<PaymentsPage teacherId="demo-teacher" />);

    expect(await screen.findByText('暂无缴费记录。')).toBeInTheDocument();
  });

  it('选择学生后展示余额预览', async () => {
    render(<PaymentsPage teacherId="demo-teacher" />);

    await screen.findByText('student-1');
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-2' } });

    await waitFor(() => expect(studentsApi.getStudentBalance).toHaveBeenCalledWith('demo-teacher', 'student-2'));
    expect(screen.getByText('余额预览')).toBeInTheDocument();
    expect(screen.getAllByText('购买课时').length).toBeGreaterThan(0);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('已消耗')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('剩余课时')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('创建缴费调用 createPayment 并刷新余额预览', async () => {
    vi.mocked(studentsApi.getStudentBalance)
      .mockResolvedValueOnce({ purchased: 12, attended: 5, remaining: 7 })
      .mockResolvedValueOnce({ purchased: 20, attended: 5, remaining: 15 });
    render(<PaymentsPage teacherId="demo-teacher" />);

    await screen.findByText('student-1');

    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-2' } });
    fireEvent.change(screen.getByLabelText('缴费金额'), { target: { value: '800' } });
    fireEvent.change(screen.getByLabelText('课时数'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('缴费日期'), { target: { value: '2026-07-09' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '补课包' } });
    fireEvent.click(screen.getByRole('button', { name: '新增缴费' }));

    expect(paymentsApi.createPayment).toHaveBeenCalledWith('demo-teacher', {
      studentId: 'student-2',
      amount: 800,
      lessonCount: 8,
      paidAt: '2026-07-09',
      note: '补课包',
    });
    expect(await screen.findByText('student-2')).toBeInTheDocument();
    expect(screen.getByText('¥800')).toBeInTheDocument();
    expect(screen.getByText('8 课时')).toBeInTheDocument();
    expect(screen.getByText('2026年7月9日')).toBeInTheDocument();
    await waitFor(() => expect(studentsApi.getStudentBalance).toHaveBeenCalledTimes(2));
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('listPayments 失败展示错误状态', async () => {
    vi.mocked(paymentsApi.listPayments).mockRejectedValue(new Error('network down'));

    render(<PaymentsPage teacherId="demo-teacher" />);

    expect(await screen.findByText('缴费记录加载失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
