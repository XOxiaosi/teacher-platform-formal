import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPage } from './FeedbackPage';
import * as feedbackApi from '../../api/feedback';
import * as studentsApi from '../../api/students';
import type { StudentData } from '../../api/types';

vi.mock('../../api/feedback');
vi.mock('../../api/students');

const baseStudent: StudentData = {
  id: 'student-1',
  teacherId: 'demo-teacher',
  name: '张三',
  grade: '初二',
  source: null,
  currentStatus: 'active',
  stageGoal: null,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
};

const baseDraft = {
  studentId: 'student-1',
  lessonIds: [] as string[],
  title: '学习反馈标题',
  content: '小明本周表现很好。',
  source: 'ai' as const,
  rationale: '',
};

const baseEvidence = [
  {
    id: 'ev-1',
    type: 'assessment' as const,
    occurredAt: '2024-09-15T08:00:00Z',
    category: 'assessment',
    summary: '月考物理成绩发布，整体进步明显',
    examName: '月考',
    subject: '物理',
    score: 83,
    fullScore: 100,
    previousScore: 78,
  },
];

const baseSavedFeedback = {
  id: 'fb-1',
  teacherId: 'demo-teacher',
  studentId: 'student-1',
  lessonId: null,
  title: '学习反馈标题',
  content: '小明本周表现很好。',
  status: 'draft' as const,
  channel: null,
  parentName: null,
  sentAt: null,
  moderationFlagged: null,
  moderationReasons: null,
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [baseStudent], total: 1 });
  vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue(baseDraft);
  vi.mocked(feedbackApi.createFeedback).mockResolvedValue(baseSavedFeedback);
  vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(feedbackApi.getFeedbackSnapshot).mockResolvedValue({
    feedbackId: 'fb-1',
    windowStart: '2024-09-01T08:00:00Z',
    windowEnd: '2024-09-30T16:00:00Z',
    assembledAt: '2026-07-15T10:00:00.000Z',
    evidence: baseEvidence,
  });
});

describe('FeedbackPage', () => {
  it('加载学生并展示下拉选项', async () => {
    render(<FeedbackPage teacherId="demo-teacher" />);

    expect(screen.getByText('正在加载学生')).toBeInTheDocument();

    expect(await screen.findByRole('option', { name: '张三 · 初二' })).toBeInTheDocument();
    expect(studentsApi.listStudents).toHaveBeenCalledWith('demo-teacher');
  });

  it('未选学生时生成按钮禁用', async () => {
    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });

    expect(screen.getByRole('button', { name: '生成反馈草稿' })).toBeDisabled();
  });

  it('选学生后点击生成，调用 generateFeedbackDraft 并展示可编辑标题与内容', async () => {
    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(feedbackApi.generateFeedbackDraft).toHaveBeenCalledWith('demo-teacher', {
      studentId: 'student-1',
      tone: 'warm',
    });
    expect(await screen.findByDisplayValue('学习反馈标题')).toBeInTheDocument();
    expect(screen.getByDisplayValue('小明本周表现很好。')).toBeInTheDocument();
    expect(screen.getByText('草稿由 AI 生成，请核对后发送。')).toBeInTheDocument();
  });

  it('生成失败展示错误信息', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockRejectedValue(new Error('AI 服务不可用'));

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(await screen.findByText('生成失败：AI 服务不可用')).toBeInTheDocument();
  });

  it('空学生列表展示空状态', async () => {
    vi.mocked(studentsApi.listStudents).mockResolvedValue({ items: [], total: 0 });

    render(<FeedbackPage teacherId="demo-teacher" />);

    expect(await screen.findByText('暂无学生')).toBeInTheDocument();
  });

  it('生成结果含 HTML 字符串时按纯文本显示', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      title: '标题',
      content: '<b>hi</b>',
    });

    const { container } = render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(await screen.findByDisplayValue('<b>hi</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('草稿包含 evidence 时渲染「证据来源」列表，含中文类型标签、摘要与分数格式', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      windowStart: '2024-09-01T08:00:00Z',
      windowEnd: '2024-09-30T16:00:00Z',
      evidence: [
        {
          id: 'ev-1',
          type: 'assessment',
          occurredAt: '2024-09-15T08:00:00Z',
          category: 'assessment',
          summary: '月考物理成绩发布，整体进步明显',
          examName: '月考',
          subject: '物理',
          score: 83,
          fullScore: 100,
          previousScore: 78,
        },
        {
          id: 'ev-2',
          type: 'record',
          occurredAt: '2024-09-20T10:00:00Z',
          category: 'lesson_observation',
          summary: '本周课堂参与积极，作业质量高',
          examName: null,
          subject: null,
          score: null,
          fullScore: null,
          previousScore: null,
        },
        {
          id: 'ev-3',
          type: 'lesson',
          occurredAt: '2024-09-10T14:00:00Z',
          category: null,
          summary: '第3次课：力学基础',
          examName: null,
          subject: null,
          score: null,
          fullScore: null,
          previousScore: null,
        },
      ],
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    // 证据来源标题
    expect(await screen.findByRole('heading', { name: '证据来源（本次反馈引用的记录）' })).toBeInTheDocument();
    expect(screen.getByText(/草稿基于以下已确认记录生成，可核对。/)).toBeInTheDocument();
    expect(screen.getByText(/时间范围：/)).toBeInTheDocument();

    // 三种类型的中文标签
    expect(screen.getByText('成绩')).toBeInTheDocument();
    expect(screen.getByText('档案')).toBeInTheDocument();
    expect(screen.getByText('课程')).toBeInTheDocument();

    // 摘要
    expect(screen.getByText('月考物理成绩发布，整体进步明显')).toBeInTheDocument();
    expect(screen.getByText('本周课堂参与积极，作业质量高')).toBeInTheDocument();
    expect(screen.getByText('第3次课：力学基础')).toBeInTheDocument();

    // 分数、满分、上次分数
    expect(screen.getByText('83/100')).toBeInTheDocument();
    expect(screen.getByText('物理')).toBeInTheDocument();
    expect(screen.getByText('月考')).toBeInTheDocument();
    expect(screen.getByText(/上次 78/)).toBeInTheDocument();
  });

  it('evidence 为空或缺失时不渲染「证据来源」区块', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      evidence: [],
    });

    const { container } = render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(await screen.findByDisplayValue('学习反馈标题')).toBeInTheDocument();
    expect(container.querySelector('.feedback-evidence')).toBeNull();
    expect(screen.queryByRole('heading', { name: '证据来源（本次反馈引用的记录）' })).toBeNull();
  });

  it('选择班型、家长类型、反馈目标后，生成请求体包含对应字段', async () => {
    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.change(screen.getByLabelText('班型'), { target: { value: 'small' } });
    fireEvent.change(screen.getByLabelText('家长类型'), { target: { value: 'scores' } });
    fireEvent.change(screen.getByLabelText('反馈目标'), { target: { value: 'highlight' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(feedbackApi.generateFeedbackDraft).toHaveBeenCalledWith('demo-teacher', {
      studentId: 'student-1',
      tone: 'warm',
      classSize: 'small',
      parentType: 'scores',
      focus: 'highlight',
    });
  });

  it('班型/家长类型/反馈目标留空时，生成请求体不含对应字段', async () => {
    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    const calledArg = vi.mocked(feedbackApi.generateFeedbackDraft).mock.calls[0][1];
    expect(calledArg).not.toHaveProperty('classSize');
    expect(calledArg).not.toHaveProperty('parentType');
    expect(calledArg).not.toHaveProperty('focus');
  });

  it('rationale 非空时渲染「所以这样写」行', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      rationale: '这位家长只看分数，所以重点突出成绩提升与下次目标。',
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(await screen.findByText('所以这样写：')).toBeInTheDocument();
    expect(screen.getByText('这位家长只看分数，所以重点突出成绩提升与下次目标。')).toBeInTheDocument();
  });

  it('rationale 为空时不渲染「所以这样写」行', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      rationale: '',
    });

    const { container } = render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    expect(await screen.findByDisplayValue('学习反馈标题')).toBeInTheDocument();
    expect(container.querySelector('.feedback-draft-rationale')).toBeNull();
    expect(screen.queryByText('所以这样写：')).toBeNull();
  });

  // ---- 保存反馈 ----
  it('草稿有内容时显示保存按钮，点击调用 createFeedback 并携带 evidence 与时间范围，成功后提示已保存并刷新列表', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      windowStart: '2024-09-01T08:00:00Z',
      windowEnd: '2024-09-30T16:00:00Z',
      evidence: baseEvidence,
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    const saveBtn = await screen.findByRole('button', { name: '保存反馈' });
    expect(saveBtn).toBeInTheDocument();

    fireEvent.click(saveBtn);

    expect(saveBtn).toBeDisabled();
    expect(feedbackApi.createFeedback).toHaveBeenCalledWith('demo-teacher', {
      studentId: 'student-1',
      title: '学习反馈标题',
      content: '小明本周表现很好。',
      evidence: baseEvidence,
      windowStart: '2024-09-01T08:00:00Z',
      windowEnd: '2024-09-30T16:00:00Z',
    });

    expect(await screen.findByText('已保存')).toBeInTheDocument();
    // 成功后刷新列表
    expect(feedbackApi.listFeedbacks).toHaveBeenCalled();
  });

  it('保存失败时显示错误信息', async () => {
    vi.mocked(feedbackApi.createFeedback).mockRejectedValue(new Error('保存失败：服务异常'));

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    const saveBtn = await screen.findByRole('button', { name: '保存反馈' });
    fireEvent.click(saveBtn);

    expect(await screen.findByText(/保存失败：保存失败：服务异常/)).toBeInTheDocument();
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('标题或内容为空时不显示保存按钮', async () => {
    vi.mocked(feedbackApi.generateFeedbackDraft).mockResolvedValue({
      ...baseDraft,
      title: '',
      content: '',
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    fireEvent.change(screen.getByLabelText('学生'), { target: { value: 'student-1' } });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));

    // 等草稿卡片出现
    expect(await screen.findByText('反馈草稿')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存反馈' })).toBeNull();
  });

  // ---- 已保存反馈列表 ----
  it('列表加载后渲染多行含状态标签、学生名、日期', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({
      items: [
        { ...baseSavedFeedback, id: 'fb-1', title: '第一份反馈', status: 'draft', createdAt: '2026-07-15T10:00:00.000Z' },
        { ...baseSavedFeedback, id: 'fb-2', title: '第二份反馈', status: 'sent', studentId: 'student-1', createdAt: '2026-07-14T10:00:00.000Z' },
      ],
      total: 2,
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    // 等学生和列表都加载完
    await screen.findByRole('option', { name: '张三 · 初二' });

    // 列表标题
    expect(await screen.findByRole('heading', { name: '已保存反馈' })).toBeInTheDocument();

    // 两条记录标题
    expect(screen.getByText('第一份反馈')).toBeInTheDocument();
    expect(screen.getByText('第二份反馈')).toBeInTheDocument();

    // 状态标签
    expect(screen.getByText('草稿')).toBeInTheDocument();
    expect(screen.getByText('已发送')).toBeInTheDocument();

    // 学生名（列表里的学生名）
    expect(screen.getAllByText('张三').length).toBeGreaterThanOrEqual(1);

    // 共 2 条
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument();
  });

  it('列表为空时展示空态文案「还没有保存的反馈」', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({ items: [], total: 0 });

    render(<FeedbackPage teacherId="demo-teacher" />);

    expect(await screen.findByText('还没有保存的反馈')).toBeInTheDocument();
    expect(screen.queryByText(/共 条/)).toBeNull();
  });

  it('列表加载失败展示错误', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockRejectedValue(new Error('网络错误'));

    render(<FeedbackPage teacherId="demo-teacher" />);

    expect(await screen.findByText(/列表加载失败：网络错误/)).toBeInTheDocument();
  });

  // ---- 本地风险标记可见化（D51） ----
  it('命中本地风险规则时列表行展示「风险标记」徽标与原因原文', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({
      items: [
        {
          ...baseSavedFeedback,
          id: 'fb-risk',
          title: '风险反馈',
          status: 'sent',
          moderationFlagged: true,
          moderationReasons: ['violence（暴力/威胁言论）', 'ad（广告/引流）'],
        },
      ],
      total: 1,
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    expect(await screen.findByText('风险反馈')).toBeInTheDocument();
    expect(screen.getByText('风险标记')).toBeInTheDocument();
    expect(screen.getByText('violence（暴力/威胁言论）')).toBeInTheDocument();
    expect(screen.getByText('ad（广告/引流）')).toBeInTheDocument();
  });

  it('未命中（false）或未配置（null）时不展示「风险标记」', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({
      items: [
        { ...baseSavedFeedback, id: 'fb-clean', title: '正常反馈', moderationFlagged: false, moderationReasons: [] },
        { ...baseSavedFeedback, id: 'fb-null', title: '未配置反馈', moderationFlagged: null, moderationReasons: null },
      ],
      total: 2,
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    await screen.findByRole('option', { name: '张三 · 初二' });
    expect(await screen.findByText('正常反馈')).toBeInTheDocument();
    expect(screen.getByText('未配置反馈')).toBeInTheDocument();
    expect(screen.queryByText('风险标记')).toBeNull();
  });

  // ---- 展开查看依据 ----
  it('点击「查看依据」展开并调用 getFeedbackSnapshot，渲染证据（类型徽标/成绩）', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({
      items: [{ ...baseSavedFeedback, id: 'fb-1' }],
      total: 1,
    });
    vi.mocked(feedbackApi.getFeedbackSnapshot).mockResolvedValue({
      feedbackId: 'fb-1',
      windowStart: '2024-09-01T08:00:00Z',
      windowEnd: '2024-09-30T16:00:00Z',
      assembledAt: '2026-07-15T10:00:00.000Z',
      evidence: baseEvidence,
    });

    render(<FeedbackPage teacherId="demo-teacher" />);

    const expandBtn = await screen.findByRole('button', { name: '查看依据' });
    fireEvent.click(expandBtn);

    expect(feedbackApi.getFeedbackSnapshot).toHaveBeenCalledWith('demo-teacher', 'fb-1');

    // 证据来源标题和内容
    expect(await screen.findByRole('heading', { name: '证据来源（本次反馈引用的记录）' })).toBeInTheDocument();
    expect(screen.getByText('成绩')).toBeInTheDocument();
    expect(screen.getByText('83/100')).toBeInTheDocument();
    expect(screen.getByText('月考物理成绩发布，整体进步明显')).toBeInTheDocument();
    expect(screen.getByText(/时间范围：/)).toBeInTheDocument();

    // 再次点击收起
    fireEvent.click(screen.getByRole('button', { name: '收起依据' }));
    expect(screen.queryByRole('heading', { name: '证据来源（本次反馈引用的记录）' })).toBeNull();
  });

  it('getFeedbackSnapshot 抛错提示「此条没有依据快照」时展示 404 文案', async () => {
    vi.mocked(feedbackApi.listFeedbacks).mockResolvedValue({
      items: [{ ...baseSavedFeedback, id: 'fb-x' }],
      total: 1,
    });
    vi.mocked(feedbackApi.getFeedbackSnapshot).mockRejectedValue(new Error('此条没有依据快照'));

    render(<FeedbackPage teacherId="demo-teacher" />);

    const expandBtn = await screen.findByRole('button', { name: '查看依据' });
    fireEvent.click(expandBtn);

    expect(await screen.findByText('此条没有依据快照')).toBeInTheDocument();
  });
});
