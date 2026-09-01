import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminTeachersApi from '../api/adminTeachers';
import * as adminActionsApi from '../api/adminActions';
import type { AdminTeacherDetail } from '../api/adminTeachers';
import { TeacherDetailPage } from './TeacherDetailPage';

vi.mock('../api/adminTeachers');
vi.mock('../api/adminActions');

const detail: AdminTeacherDetail = {
  teacher: {
    id: 'teacher-1',
    email: 'a@b.com',
    displayName: '张三',
    status: 'active',
    databaseName: 'teacher_db_a',
    createdAtTs: '2026-08-01T02:00:00.000Z',
    updatedAtTs: '2026-08-02T02:00:00.000Z',
  },
  aggregates: {
    studentCount: 5,
    scheduleCount: 8,
    lessonCount: 12,
    paymentCount: 3,
    feedbackCount: 2,
    agentExecutionCount: 20,
    lastInteractionAtTs: '2026-08-02T04:00:00.000Z',
    recentExecutions: [
      { id: 'exec-1', status: 'succeeded', startedAtTs: '2026-08-02T04:00:00.000Z', finishedAtTs: null, summary: '查课表' },
    ],
  },
  degraded: false,
  degradedReason: null,
};

beforeEach(() => {
  vi.mocked(adminTeachersApi.getTeacherDetail).mockReset().mockResolvedValue(detail);
  vi.mocked(adminActionsApi.updateTeacherStatus).mockReset().mockResolvedValue({ id: 'teacher-1', status: 'disabled' });
  vi.mocked(adminActionsApi.triggerBackup).mockReset().mockResolvedValue({ jobId: 'job-1' });
  vi.mocked(adminActionsApi.pollBackupStatus).mockReset().mockResolvedValue({ status: 'succeeded', detail: 'MANIFEST ok' });
  vi.mocked(adminActionsApi.triggerRestore).mockReset().mockResolvedValue({ ok: true });
  vi.restoreAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('TeacherDetailPage', () => {
  it('加载详情并渲染账号信息与聚合指标', async () => {
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);

    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
    expect(screen.getByText('teacher_db_a')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // studentCount
    expect(screen.getByText('8')).toBeInTheDocument(); // scheduleCount
    expect(screen.getByText('12')).toBeInTheDocument(); // lessonCount
    expect(screen.getByText('20')).toBeInTheDocument(); // agentExecutionCount
    expect(screen.getByText('查课表')).toBeInTheDocument(); // 最近交互
    expect(adminTeachersApi.getTeacherDetail).toHaveBeenCalledWith('teacher-1');
  });

  it('degraded 标记：聚合超时时展示提示且指标仍渲染', async () => {
    vi.mocked(adminTeachersApi.getTeacherDetail).mockResolvedValue({
      ...detail,
      degraded: true,
      degradedReason: '单库聚合超过 5s',
    });
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);

    expect(await screen.findByText(/聚合超时/)).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('聚合不可用（null）时展示提示', async () => {
    vi.mocked(adminTeachersApi.getTeacherDetail).mockResolvedValue({
      ...detail,
      aggregates: null,
      degraded: true,
      degradedReason: '单库不可达',
    });
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);

    expect(await screen.findByText('聚合数据不可用。')).toBeInTheDocument();
  });

  it('禁用账号：confirm 通过后 PATCH status=disabled 并显示审计 toast', async () => {
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '禁用账号' }));

    await waitFor(() => expect(adminActionsApi.updateTeacherStatus).toHaveBeenCalledWith('teacher-1', 'disabled'));
    expect(screen.getByText(/已记录审计/)).toBeInTheDocument();
  });

  it('禁用账号：confirm 取消则不调用 API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '禁用账号' }));

    await waitFor(() => expect(adminActionsApi.updateTeacherStatus).not.toHaveBeenCalled());
  });

  it('停用教师显示「启用账号」按钮', async () => {
    vi.mocked(adminTeachersApi.getTeacherDetail).mockResolvedValue({
      ...detail,
      teacher: { ...detail.teacher, status: 'disabled' },
    });
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    expect(screen.getByRole('button', { name: '启用账号' })).toBeInTheDocument();
  });

  it('手动备份：POST /admin/backup → jobId 轮询到 succeeded 显示完成', async () => {
    vi.mocked(adminActionsApi.pollBackupStatus)
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'succeeded', detail: 'MANIFEST ok' });
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} pollDelayMs={1} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '手动备份' }));

    await screen.findByText(/备份完成/, {}, { timeout: 3000 });
    expect(adminActionsApi.triggerBackup).toHaveBeenCalledWith('teacher-1');
    expect(adminActionsApi.pollBackupStatus).toHaveBeenCalledWith('job-1');
    expect(adminActionsApi.pollBackupStatus).toHaveBeenCalledTimes(2);
  });

  it('备份失败展示错误信封 message', async () => {
    vi.mocked(adminActionsApi.pollBackupStatus).mockResolvedValueOnce({ status: 'failed', detail: '备份目录不可写' });
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} pollDelayMs={1} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '手动备份' }));

    expect(await screen.findByText(/备份失败：备份目录不可写/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('恢复演练：confirm 通过后 POST /admin/restore?confirm=1 并显示审计 toast', async () => {
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.change(screen.getByLabelText('演练目标数据库名'), {
      target: { value: 'teacher_db_demo_restore_20260831' },
    });
    fireEvent.click(screen.getByRole('button', { name: '执行恢复演练' }));

    await waitFor(() => expect(adminActionsApi.triggerRestore).toHaveBeenCalledWith({
      targetDatabaseName: 'teacher_db_demo_restore_20260831',
    }));
    expect(screen.getByText(/已记录审计/)).toBeInTheDocument();
  });

  it('恢复演练：confirm 取消则不调用 API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.change(screen.getByLabelText('演练目标数据库名'), { target: { value: 'teacher_db_demo_restore_x' } });
    fireEvent.click(screen.getByRole('button', { name: '执行恢复演练' }));

    await waitFor(() => expect(adminActionsApi.triggerRestore).not.toHaveBeenCalled());
  });

  it('恢复表单提示仅允许演练目标', async () => {
    render(<TeacherDetailPage teacherId="teacher-1" onBack={() => undefined} />);
    await screen.findByText('张三');

    expect(screen.getByText(/仅演练目标/)).toBeInTheDocument();
  });

  it('加载失败展示错误与返回按钮', async () => {
    vi.mocked(adminTeachersApi.getTeacherDetail).mockRejectedValue(new Error('network down'));
    const onBack = vi.fn();
    render(<TeacherDetailPage teacherId="teacher-1" onBack={onBack} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('教师详情加载失败');
    fireEvent.click(screen.getByRole('button', { name: '返回教师总览' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('返回按钮回调 onBack', async () => {
    const onBack = vi.fn();
    render(<TeacherDetailPage teacherId="teacher-1" onBack={onBack} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '返回教师总览' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
