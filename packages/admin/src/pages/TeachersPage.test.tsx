import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminTeachersApi from '../api/adminTeachers';
import * as adminActionsApi from '../api/adminActions';
import type { AdminTeacherListItem } from '../api/adminTeachers';
import { TeachersPage } from './TeachersPage';

vi.mock('../api/adminTeachers');
vi.mock('../api/adminActions');

const teachers: AdminTeacherListItem[] = [
  {
    id: 'teacher-1',
    email: 'a@b.com',
    displayName: '张三',
    status: 'active',
    databaseName: 'teacher_db_a',
    createdAtTs: '2026-08-01T02:00:00.000Z',
    updatedAtTs: '2026-08-02T02:00:00.000Z',
  },
  {
    id: 'teacher-2',
    email: 'c@d.com',
    displayName: '李四',
    status: 'disabled',
    databaseName: 'teacher_db_b',
    createdAtTs: '2026-07-01T02:00:00.000Z',
    updatedAtTs: '2026-07-05T02:00:00.000Z',
  },
];

beforeEach(() => {
  vi.mocked(adminTeachersApi.listTeachers).mockReset().mockResolvedValue({ items: teachers, total: 2 });
  vi.mocked(adminActionsApi.createTeacher).mockReset().mockResolvedValue({
    id: 'teacher-new',
    email: 'new@b.com',
    displayName: '新老师',
    status: 'active',
    databaseName: 'teacher_db_new',
  });
});

describe('TeachersPage', () => {
  it('渲染教师列表：姓名/邮箱/状态/数据库/注册时间', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);

    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
    expect(screen.getByText('李四')).toBeInTheDocument();
    expect(screen.getByText('teacher_db_a')).toBeInTheDocument();
    expect(screen.getByText('teacher_db_b')).toBeInTheDocument();
    expect(screen.getAllByText('启用').length).toBeGreaterThan(0);
    expect(screen.getAllByText('停用').length).toBeGreaterThan(0);
    expect(screen.getByText('共 2 位教师')).toBeInTheDocument();
  });

  it('状态过滤：切换 select 以过滤参数重新请求', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.change(screen.getByLabelText('状态过滤'), { target: { value: 'disabled' } });

    await waitFor(() => expect(adminTeachersApi.listTeachers).toHaveBeenLastCalledWith({
      status: 'disabled',
      page: 1,
      pageSize: 20,
    }));
  });

  it('点击教师行回调 onSelectTeacher(id)', async () => {
    const onSelectTeacher = vi.fn();
    render(<TeachersPage onSelectTeacher={onSelectTeacher} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: /张三/ }));

    expect(onSelectTeacher).toHaveBeenCalledWith('teacher-1');
  });

  it('分页：下一页/上一页切换 page 参数', async () => {
    vi.mocked(adminTeachersApi.listTeachers).mockResolvedValue({ items: [teachers[0]], total: 25 });
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(adminTeachersApi.listTeachers).toHaveBeenLastCalledWith({
      status: undefined,
      page: 2,
      pageSize: 20,
    }));

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => expect(adminTeachersApi.listTeachers).toHaveBeenLastCalledWith({
      status: undefined,
      page: 1,
      pageSize: 20,
    }));
  });

  it('空列表展示空态；加载失败展示错误', async () => {
    vi.mocked(adminTeachersApi.listTeachers).mockResolvedValue({ items: [], total: 0 });
    const { unmount } = render(<TeachersPage onSelectTeacher={() => undefined} />);
    expect(await screen.findByText('暂无教师记录。')).toBeInTheDocument();
    unmount();

    vi.mocked(adminTeachersApi.listTeachers).mockRejectedValue(new Error('network down'));
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('列表加载失败：network down');
  });

  it('新建教师：填写表单提交调用 createTeacher 并显示审计 toast', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '新建教师' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新老师' } });
    fireEvent.change(screen.getByLabelText('数据库名（可选，缺省自动生成）'), { target: { value: 'teacher_db_new' } });
    fireEvent.click(screen.getByRole('button', { name: '创建教师' }));

    await waitFor(() => expect(adminActionsApi.createTeacher).toHaveBeenCalledWith({
      email: 'new@b.com',
      password: 'secret123',
      displayName: '新老师',
      databaseName: 'teacher_db_new',
    }, false));
    expect(screen.getByText(/已记录审计/)).toBeInTheDocument();
  });

  it('新建教师：勾选同时建库时 provision=1', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '新建教师' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新老师' } });
    fireEvent.click(screen.getByLabelText('同时建库（provision=1，后台任务）'));
    fireEvent.click(screen.getByRole('button', { name: '创建教师' }));

    await waitFor(() => expect(adminActionsApi.createTeacher).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@b.com' }),
      true,
    ));
  });

  it('新建教师：必填缺失时提交按钮禁用，不调用 createTeacher', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '新建教师' }));
    expect(screen.getByRole('button', { name: '创建教师' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '创建教师' }));

    expect(adminActionsApi.createTeacher).not.toHaveBeenCalled();
  });

  it('新建教师失败展示错误信封 message', async () => {
    vi.mocked(adminActionsApi.createTeacher).mockRejectedValue(new Error('邮箱已注册'));
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('张三');

    fireEvent.click(screen.getByRole('button', { name: '新建教师' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'dup@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '重复老师' } });
    fireEvent.click(screen.getByRole('button', { name: '创建教师' }));

    expect(await screen.findByText('创建失败：邮箱已注册')).toBeInTheDocument();
  });
});
