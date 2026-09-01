import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminFeedbackApi from '../api/adminFeedback';
import type { FeedbackBoardItem, FeedbackSummary } from '../api/adminFeedback';
import { FeedbackBoardPage } from './FeedbackBoardPage';

vi.mock('../api/adminFeedback');

const baseItem: FeedbackBoardItem = {
  id: 'req-1',
  teacherId: null,
  verbatimQuote: '希望增加批量导入功能，支持 CSV 文件上传，并且能识别重复数据',
  sourceType: 'teacher_feedback',
  sourceDbName: null,
  sourceTurnId: null,
  contextSummary: '教师在对话中提到希望支持批量导入学生，最好能去重。',
  occurredAtTs: '2026-08-10T02:00:00.000Z',
  parsedIntent: '批量导入学生数据',
  category: 'feature',
  priority: 'high',
  status: 'new',
  linkedDesignDoc: null,
  linkedTaskId: 't42',
  linkedCommitSha: null,
  createdAtTs: '2026-08-10T02:00:00.000Z',
  updatedAtTs: '2026-08-10T02:00:00.000Z',
};

const triagedItem: FeedbackBoardItem = {
  ...baseItem,
  id: 'req-2',
  verbatimQuote: '手机端查看日程时字体太小',
  contextSummary: '移动端体验问题。',
  parsedIntent: '移动端字体可调',
  category: 'ux',
  priority: 'normal',
  status: 'triaged',
};

const summary: FeedbackSummary = {
  total: 3,
  byStatus: [{ status: 'new', count: 2 }, { status: 'triaged', count: 1 }],
  byPriority: [{ priority: 'high', count: 2 }, { priority: 'normal', count: 1 }],
  byCategory: [{ category: 'feature', count: 2 }, { category: 'ux', count: 1 }],
  recent: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminFeedbackApi.listFeedback).mockResolvedValue({ items: [baseItem, triagedItem], total: 2 });
  vi.mocked(adminFeedbackApi.getFeedbackSummary).mockResolvedValue(summary);
  vi.mocked(adminFeedbackApi.updateFeedbackStatus).mockResolvedValue({ ...baseItem, status: 'triaged' });
  vi.mocked(adminFeedbackApi.updateFeedbackLinks).mockResolvedValue({ ...baseItem });
});

describe('FeedbackBoardPage', () => {
  it('渲染看板：汇总分布 + 列表行 + 状态/优先级徽标 + 分页计数', async () => {
    render(<FeedbackBoardPage />);

    expect(await screen.findByRole('heading', { name: '反馈看板' })).toBeInTheDocument();
    expect(await screen.findByText('共 2 条反馈')).toBeInTheDocument();

    // 汇总（等 summary 异步加载完成）
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('总反馈')).toBeInTheDocument();
    expect(screen.getByText('按状态')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '待处理 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '紧急' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高 2' })).toBeInTheDocument();

    // 列表（「待处理/评估中」同时出现在过滤 select 选项、chip 与状态徽标中）
    expect(screen.getAllByText('待处理').length).toBeGreaterThan(0);
    expect(screen.getAllByText('评估中').length).toBeGreaterThan(0);
    expect(screen.getAllByText('详情').length).toBe(2);

    expect(adminFeedbackApi.listFeedback).toHaveBeenCalledWith({
      page: 1,
      pageSize: 10,
      status: undefined,
      category: undefined,
      priority: undefined,
    });
    expect(adminFeedbackApi.getFeedbackSummary).toHaveBeenCalledTimes(1);
    expect(adminFeedbackApi.getFeedbackSummary).toHaveBeenCalledWith();
  });

  it('过滤：状态/分类/优先级 select 与重置按钮', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'triaged' } });
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: 'triaged',
      category: undefined,
      priority: undefined,
    }));

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'bug_report' } });
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: 'urgent' } });
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: 'triaged',
      category: 'bug_report',
      priority: 'urgent',
    }));

    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: undefined,
      category: undefined,
      priority: undefined,
    }));
  });

  it('汇总 chips 点击切换对应过滤（再点取消）', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getByRole('button', { name: '待处理 2' }));
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: 'new',
      category: undefined,
      priority: undefined,
    }));

    fireEvent.click(screen.getByRole('button', { name: '高 2' }));
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: 'new',
      category: undefined,
      priority: 'high',
    }));
  });

  it('分页：下一页请求 page=2，上一页回到 page=1', async () => {
    vi.mocked(adminFeedbackApi.listFeedback).mockResolvedValue({ items: [], total: 25 });

    render(<FeedbackBoardPage />);
    await screen.findByText('共 25 条反馈');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 10,
      status: undefined,
      category: undefined,
      priority: undefined,
    }));
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 10,
      status: undefined,
      category: undefined,
      priority: undefined,
    }));
  });

  it('详情展开：展示原话全文/上下文摘要/解析意图/时间/来源/关联', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);

    // 原话较短（未截断）会同时出现在行内与详情；用详情独有字段断言展开
    expect(await screen.findByText('上下文摘要')).toBeInTheDocument();
    expect(screen.getByText('教师在对话中提到希望支持批量导入学生，最好能去重。')).toBeInTheDocument();
    expect(screen.getAllByText('批量导入学生数据').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2026年8月10日/).length).toBeGreaterThan(0);
    expect(screen.getByText('teacher_feedback')).toBeInTheDocument();
    expect(screen.getByText('任务：t42')).toBeInTheDocument();

    // 收起
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('上下文摘要')).not.toBeInTheDocument();
  });

  it('管理动作：确认后 updateFeedbackStatus + 审计 toast + 刷新列表与汇总', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: '评估中' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('评估中'));
    expect(adminFeedbackApi.updateFeedbackStatus).toHaveBeenCalledWith({
      requirementId: 'req-1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      status: 'triaged',
    });

    expect(await screen.findByText('已更新为「评估中」，审计已记录')).toBeInTheDocument();
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(adminFeedbackApi.getFeedbackSummary).toHaveBeenCalledTimes(2));
    confirmSpy.mockRestore();
  });

  it('管理动作：confirm 取消时不调用 update', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: '评估中' }));

    expect(adminFeedbackApi.updateFeedbackStatus).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('管理动作：VERSION_CONFLICT 提示已被他人更新', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(adminFeedbackApi.updateFeedbackStatus).mockRejectedValue(
      new Error('VERSION_CONFLICT: 已被他人更新'),
    );

    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: '评估中' }));

    expect(await screen.findByText('状态更新失败：该反馈已被其他管理员更新，请刷新后重试')).toBeInTheDocument();
  });

  it('P15 关联编辑：三个输入预填当前值，无变更时保存按钮禁用', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);

    expect(await screen.findByLabelText('设计文档')).toHaveValue('');
    expect(screen.getByLabelText('任务 ID')).toHaveValue('t42');
    expect(screen.getByLabelText('提交 SHA')).toHaveValue('');
    expect(screen.getByRole('button', { name: '保存关联' })).toBeDisabled();
  });

  it('P15 关联编辑：只提交与当前值不同的字段 + 审计 toast + 刷新列表', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    const docInput = await screen.findByLabelText('设计文档');
    fireEvent.change(docInput, { target: { value: 'reports/architecture/demo.md' } });
    fireEvent.click(screen.getByRole('button', { name: '保存关联' }));

    expect(adminFeedbackApi.updateFeedbackLinks).toHaveBeenCalledWith({
      requirementId: 'req-1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      linkedDesignDoc: 'reports/architecture/demo.md',
    });
    expect(await screen.findByText('关联信息已保存，审计已记录')).toBeInTheDocument();
    await waitFor(() => expect(adminFeedbackApi.listFeedback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(adminFeedbackApi.getFeedbackSummary).toHaveBeenCalledTimes(2));
  });

  it('P15 关联编辑：输入清空 → 提交空字符串（清除关联）', async () => {
    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    const taskInput = await screen.findByLabelText('任务 ID');
    fireEvent.change(taskInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存关联' }));

    expect(adminFeedbackApi.updateFeedbackLinks).toHaveBeenCalledWith({
      requirementId: 'req-1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      linkedTaskId: '',
    });
    expect(await screen.findByText('关联信息已保存，审计已记录')).toBeInTheDocument();
  });

  it('P15 关联编辑：VERSION_CONFLICT → 提示已被他人更新', async () => {
    vi.mocked(adminFeedbackApi.updateFeedbackLinks).mockRejectedValue(
      new Error('VERSION_CONFLICT: 已被他人更新'),
    );

    render(<FeedbackBoardPage />);
    await screen.findByText('共 2 条反馈');

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    fireEvent.change(await screen.findByLabelText('设计文档'), { target: { value: 'docs/x.md' } });
    fireEvent.click(screen.getByRole('button', { name: '保存关联' }));

    expect(await screen.findByText('关联保存失败：该反馈已被其他管理员更新，请刷新后重试')).toBeInTheDocument();
  });

  it('空列表展示空状态', async () => {
    vi.mocked(adminFeedbackApi.listFeedback).mockResolvedValue({ items: [], total: 0 });

    render(<FeedbackBoardPage />);

    expect(await screen.findByText('暂无反馈记录。')).toBeInTheDocument();
  });

  it('列表加载失败展示错误状态', async () => {
    vi.mocked(adminFeedbackApi.listFeedback).mockRejectedValue(new Error('network down'));

    render(<FeedbackBoardPage />);

    expect(await screen.findByText('列表加载失败：network down')).toBeInTheDocument();
  });

  it('汇总加载失败不阻断列表', async () => {
    vi.mocked(adminFeedbackApi.getFeedbackSummary).mockRejectedValue(new Error('summary down'));

    render(<FeedbackBoardPage />);

    expect(await screen.findByText('汇总加载失败：summary down')).toBeInTheDocument();
    expect(screen.getByText('共 2 条反馈')).toBeInTheDocument();
  });
});
