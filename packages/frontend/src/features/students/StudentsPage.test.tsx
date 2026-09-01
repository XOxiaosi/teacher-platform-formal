import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentsPage } from './StudentsPage';
import * as studentsApi from '../../api/students';
import type { StudentData } from '../../api/types';

vi.mock('../../api/students');

const baseStudent: StudentData = {
  id: 'student-1',
  teacherId: 'demo-teacher',
  name: '张三',
  grade: '高三',
  source: '转介绍',
  currentStatus: 'active',
  stageGoal: '一轮复习提分',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [baseStudent], total: 1 });
  vi.mocked(studentsApi.getStudentBalance).mockResolvedValue({ purchased: 12, attended: 5, remaining: 7 });
});

describe('StudentsPage', () => {
  it('加载并展示学生列表', async () => {
    render(<StudentsPage teacherId="demo-teacher" />);

    expect(screen.getByText('正在加载学生列表')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '学生中心' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /张三/ })).toBeInTheDocument();
    expect(screen.getByText('高三')).toBeInTheDocument();
    expect(studentsApi.listStudents).toHaveBeenCalledWith('demo-teacher');
  });

  it('空数据展示空状态', async () => {
    vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [], total: 0 });

    render(<StudentsPage teacherId="demo-teacher" />);

    expect(await screen.findByText('还没有学生档案')).toBeInTheDocument();
    expect(screen.getByText('先用右侧表单创建第一个学生。')).toBeInTheDocument();
  });

  it('创建学生调用 createStudent 并展示新学生', async () => {
    const createdStudent: StudentData = {
      ...baseStudent,
      id: 'student-2',
      name: '李四',
      grade: '初三',
      source: '家长咨询',
      stageGoal: '中考冲刺',
    };
    vi.mocked(studentsApi.createStudent).mockResolvedValue(createdStudent);

    render(<StudentsPage teacherId="demo-teacher" />);

    await screen.findByRole('heading', { name: '学生中心' });
    fireEvent.click(screen.getByRole('button', { name: '新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '李四' } });
    fireEvent.change(screen.getByLabelText('年级'), { target: { value: '初三' } });
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: '家长咨询' } });
    fireEvent.change(screen.getByLabelText('阶段目标'), { target: { value: '中考冲刺' } });
    fireEvent.click(screen.getByRole('button', { name: '创建学生' }));

    await waitFor(() => {
      expect(studentsApi.createStudent).toHaveBeenCalledWith('demo-teacher', {
        name: '李四',
        grade: '初三',
        source: '家长咨询',
        stageGoal: '中考冲刺',
      });
    });
    expect(await screen.findByRole('button', { name: /李四/ })).toBeInTheDocument();
    expect(screen.getByText('学生已创建')).toBeInTheDocument();
  });

  it('listStudents 失败展示错误状态', async () => {
    vi.mocked(studentsApi.listStudents).mockRejectedValue(new Error('network down'));

    render(<StudentsPage teacherId="demo-teacher" />);

    expect(await screen.findByText('学生列表加载失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('点击学生展示基础档案详情和课时余额', async () => {
    render(<StudentsPage teacherId="demo-teacher" />);

    fireEvent.click(await screen.findByRole('button', { name: /张三/ }));

    const profile = screen.getByRole('heading', { name: '学生档案' }).closest('article');
    expect(profile).not.toBeNull();
    expect(within(profile as HTMLElement).getByText('一轮复习提分')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('转介绍')).toBeInTheDocument();
    await waitFor(() => expect(studentsApi.getStudentBalance).toHaveBeenCalledWith('demo-teacher', 'student-1'));
    expect(within(profile as HTMLElement).getByText('购买课时')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('12')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('已消耗')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('5')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('剩余课时')).toBeInTheDocument();
    expect(within(profile as HTMLElement).getByText('7')).toBeInTheDocument();
  });

  it('对象路径命中同teacher已加载学生时自动选中，不新增详情请求', async () => {
    const focusedStudent: StudentData = {
      ...baseStudent,
      id: 'student/2',
      name: '李四',
      stageGoal: '对象路径选中目标',
    };
    vi.mocked(studentsApi.listStudents).mockResolvedValue({
      items: [baseStudent, focusedStudent],
      total: 2,
    });

    render(<StudentsPage teacherId="demo-teacher" focusedStudentId="student/2" />);

    const focusedRow = await screen.findByRole('button', { name: /李四/ });
    expect(focusedRow).toHaveAttribute('aria-current', 'true');
    const profile = screen.getByRole('heading', { name: '学生档案' }).closest('article');
    expect(profile).not.toBeNull();
    expect(within(profile as HTMLElement).getByText('对象路径选中目标')).toBeInTheDocument();
    await waitFor(() => expect(studentsApi.getStudentBalance).toHaveBeenCalledWith('demo-teacher', 'student/2'));
    expect(studentsApi.listStudents).toHaveBeenCalledTimes(1);
  });

  it('对象路径未命中时保持普通StudentsPage且不读取未知学生', async () => {
    render(<StudentsPage teacherId="demo-teacher" focusedStudentId="missing" />);

    await screen.findByRole('heading', { name: '学生中心' });
    expect(screen.getByText('点击左侧学生，查看基础档案信息。')).toBeInTheDocument();
    expect(studentsApi.getStudentBalance).not.toHaveBeenCalled();
  });

  describe('新增学生表单折叠', () => {
    it('新增学生表单默认不展开', async () => {
      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });

      expect(screen.queryByLabelText('姓名')).toBeNull();
      expect(screen.queryByRole('button', { name: '创建学生' })).toBeNull();
    });

    it('点击新增学生按钮展开表单', async () => {
      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.click(screen.getByRole('button', { name: '新增学生' }));

      expect(screen.getByLabelText('姓名')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '创建学生' })).toBeInTheDocument();
    });

    it('展开后可以收起表单', async () => {
      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.click(screen.getByRole('button', { name: '新增学生' }));
      expect(screen.getByLabelText('姓名')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '收起' }));

      expect(screen.queryByLabelText('姓名')).toBeNull();
      expect(screen.getByRole('button', { name: '新增学生' })).toBeInTheDocument();
    });

    it('创建学生成功后表单收起', async () => {
      const createdStudent: StudentData = {
        ...baseStudent,
        id: 'student-2',
        name: '李四',
        grade: '初三',
      };
      vi.mocked(studentsApi.createStudent).mockResolvedValue(createdStudent);

      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.click(screen.getByRole('button', { name: '新增学生' }));
      fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '李四' } });
      fireEvent.change(screen.getByLabelText('年级'), { target: { value: '初三' } });
      fireEvent.click(screen.getByRole('button', { name: '创建学生' }));

      await waitFor(() => expect(screen.getByText('学生已创建')).toBeInTheDocument());
      expect(screen.queryByLabelText('姓名')).toBeNull();
      expect(screen.getByRole('button', { name: '新增学生' })).toBeInTheDocument();
    });
  });

  describe('学生列表搜索', () => {
    const threeStudents = [
      baseStudent,
      { ...baseStudent, id: 'student-2', name: '李四', grade: '初三' },
      { ...baseStudent, id: 'student-3', name: '王五', grade: '高三' },
    ];

    it('展示搜索输入框', async () => {
      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });

      expect(screen.getByPlaceholderText('搜索学生姓名或年级')).toBeInTheDocument();
    });

    it('按姓名搜索过滤学生列表', async () => {
      vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: threeStudents, total: 3 });

      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.change(screen.getByPlaceholderText('搜索学生姓名或年级'), { target: { value: '李四' } });

      expect(screen.getByRole('button', { name: /李四/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /张三/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /王五/ })).toBeNull();
    });

    it('按年级搜索过滤学生列表', async () => {
      vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: threeStudents, total: 3 });

      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.change(screen.getByPlaceholderText('搜索学生姓名或年级'), { target: { value: '初三' } });

      expect(screen.getByRole('button', { name: /李四/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /张三/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /王五/ })).toBeNull();
    });

    it('清空搜索恢复全部学生', async () => {
      vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: threeStudents, total: 3 });

      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.change(screen.getByPlaceholderText('搜索学生姓名或年级'), { target: { value: '李四' } });
      expect(screen.queryByRole('button', { name: /张三/ })).toBeNull();

      fireEvent.change(screen.getByPlaceholderText('搜索学生姓名或年级'), { target: { value: '' } });

      expect(screen.getByRole('button', { name: /张三/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /李四/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /王五/ })).toBeInTheDocument();
    });

    it('搜索无匹配时展示空状态', async () => {
      vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: threeStudents, total: 3 });

      render(<StudentsPage teacherId="demo-teacher" />);

      await screen.findByRole('heading', { name: '学生中心' });
      fireEvent.change(screen.getByPlaceholderText('搜索学生姓名或年级'), { target: { value: '不存在' } });

      expect(screen.queryByRole('button', { name: /张三/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /李四/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /王五/ })).toBeNull();
      expect(screen.getByText('没有匹配的学生')).toBeInTheDocument();
    });
  });
});
