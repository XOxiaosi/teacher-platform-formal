import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import * as requirementsApi from '../../api/requirements';
import type { RequirementData } from '../../api/requirements';
import { UserFeedbackPage } from './UserFeedbackPage';

vi.mock('../../api/requirements');

const ownItem: RequirementData = {
  id: 'req-1',
  teacherId: 'teacher-1',
  verbatimQuote: '手机端日程不好用',
  sourceType: null,
  sourceDbName: null,
  sourceTurnId: null,
  contextSummary: '移动端日程体验',
  occurredAtTs: '2026-08-31T02:00:00.000Z',
  parsedIntent: '希望有纵向日程',
  category: 'ux',
  priority: 'high',
  status: 'new',
  linkedDesignDoc: null,
  linkedTaskId: null,
  linkedCommitSha: null,
  createdAtTs: '2026-08-31T02:00:00.000Z',
  updatedAtTs: '2026-08-31T02:00:00.000Z',
};

const platformItem: RequirementData = {
  ...ownItem,
  id: 'req-platform',
  teacherId: null,
  contextSummary: '平台级公告',
  verbatimQuote: '平台计划上线导出功能',
};

beforeEach(() => {
  vi.mocked(requirementsApi.listRequirements).mockReset().mockResolvedValue({ items: [ownItem], total: 1 });
  vi.mocked(requirementsApi.createRequirement).mockReset().mockResolvedValue(ownItem);
  vi.mocked(requirementsApi.updateRequirement).mockReset().mockResolvedValue({ ...ownItem, priority: 'urgent' });
});

describe('UserFeedbackPage', () => {
  it('渲染表单字段：类型/标题/描述/期望行为/优先级自评/提交按钮', async () => {
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('我的反馈');

    expect(screen.getByLabelText('反馈类型')).toBeInTheDocument();
    expect(screen.getByLabelText('优先级自评')).toBeInTheDocument();
    expect(screen.getByLabelText('标题')).toBeInTheDocument();
    expect(screen.getByLabelText('描述')).toBeInTheDocument();
    expect(screen.getByLabelText('期望行为（可选）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交反馈' })).toBeInTheDocument();
  });

  it('标题/描述为空时提交按钮禁用，不调用 createRequirement', async () => {
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('我的反馈');

    const submit = screen.getByRole('button', { name: '提交反馈' });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(requirementsApi.createRequirement).not.toHaveBeenCalled();
  });

  it('合法提交调用 createRequirement（字段映射：描述→verbatimQuote/标题→contextSummary/期望→parsedIntent）并清空表单', async () => {
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('我的反馈');

    fireEvent.change(screen.getByLabelText('反馈类型'), { target: { value: 'bug_report' } });
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '保存按钮不生效' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '点保存没反应' } });
    fireEvent.change(screen.getByLabelText('期望行为（可选）'), { target: { value: '点击后应保存' } });
    fireEvent.change(screen.getByLabelText('优先级自评'), { target: { value: 'urgent' } });
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));

    await waitFor(() => expect(requirementsApi.createRequirement).toHaveBeenCalledWith('teacher-1', {
      verbatimQuote: '点保存没反应',
      contextSummary: '保存按钮不生效',
      parsedIntent: '点击后应保存',
      category: 'bug_report',
      priority: 'urgent',
    }));
    expect(screen.getByLabelText('标题')).toHaveValue('');
    expect(screen.getByLabelText('描述')).toHaveValue('');
    await screen.findByText('已提交，感谢反馈。');
  });

  it('提交失败展示 role=alert 错误条', async () => {
    vi.mocked(requirementsApi.createRequirement).mockRejectedValue(
      new ApiError({ code: 'VALIDATION_ERROR', message: '分类不合法', field: 'category' }),
    );
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('我的反馈');

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '描述内容' } });
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('提交失败：分类不合法');
  });

  it('列表渲染：状态徽标/分类/优先级/时间；自己的记录有编辑按钮，平台级记录只读', async () => {
    vi.mocked(requirementsApi.listRequirements).mockResolvedValue({ items: [ownItem, platformItem], total: 2 });
    render(<UserFeedbackPage teacherId="teacher-1" />);

    const list = await screen.findByText('移动端日程体验').then(() => (
      document.querySelector('.feedback-requirement-list') as HTMLElement
    ));
    expect(list).not.toBeNull();
    const listWithin = within(list);

    expect(listWithin.getByText('手机端日程不好用')).toBeInTheDocument();
    expect(listWithin.getAllByText('期望行为：希望有纵向日程').length).toBe(2); // own + platform 均有
    expect(listWithin.getAllByText('新提交').length).toBe(2); // 状态徽标（status 5 态）
    expect(listWithin.getAllByText('界面体验').length).toBe(2); // 分类标签（表单 select 不含在内）
    expect(listWithin.getByText('平台级公告')).toBeInTheDocument();

    const editButtons = screen.getAllByRole('button', { name: '编辑' });
    expect(editButtons.length).toBe(1); // 仅自己的记录可编辑
  });

  it('空列表展示空态', async () => {
    vi.mocked(requirementsApi.listRequirements).mockResolvedValue({ items: [], total: 0 });
    render(<UserFeedbackPage teacherId="teacher-1" />);

    expect(await screen.findByText('还没有提交过反馈。')).toBeInTheDocument();
  });

  it('列表加载失败展示错误', async () => {
    vi.mocked(requirementsApi.listRequirements).mockRejectedValue(new Error('network down'));
    render(<UserFeedbackPage teacherId="teacher-1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('列表加载失败：network down');
  });

  it('编辑自己的记录：保存调用 PATCH（expectedUpdatedAt + changes）并更新列表', async () => {
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('移动端日程体验');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getAllByLabelText('优先级')[0], { target: { value: 'urgent' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(requirementsApi.updateRequirement).toHaveBeenCalledWith('teacher-1', 'req-1', {
      expectedUpdatedAt: '2026-08-31T02:00:00.000Z',
      changes: { category: 'ux', priority: 'urgent' },
    }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument());
  });

  it('乐观锁冲突（VERSION_CONFLICT）展示提示并刷新列表', async () => {
    vi.mocked(requirementsApi.updateRequirement).mockRejectedValue(
      new ApiError({ code: 'VERSION_CONFLICT', message: '记录已被其他操作更新，请刷新后重试', field: 'expectedUpdatedAt' }),
    );
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('移动端日程体验');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('已被其他操作更新');
    expect(requirementsApi.listRequirements).toHaveBeenCalledTimes(2); // 初始 + 冲突后刷新
  });

  it('取消编辑不调用 PATCH', async () => {
    render(<UserFeedbackPage teacherId="teacher-1" />);
    await screen.findByText('移动端日程体验');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(requirementsApi.updateRequirement).not.toHaveBeenCalled();
  });
});
