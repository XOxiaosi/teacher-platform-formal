import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StudentDetailPage } from './StudentDetailPage';

// Mock all student API functions
const mockListStudents = vi.fn();
const mockGetStudentTimeline = vi.fn();
const mockListStudentRecords = vi.fn();
const mockReviewStudentRecord = vi.fn();
const mockCaptureScoreFromText = vi.fn();
const mockCaptureCommunicationFromText = vi.fn();
const mockUpdateCommunicationDetail = vi.fn();

vi.mock('../../api/students', () => ({
  listStudents: (...args: unknown[]) => mockListStudents(...args),
  getStudentTimeline: (...args: unknown[]) => mockGetStudentTimeline(...args),
  listStudentRecords: (...args: unknown[]) => mockListStudentRecords(...args),
  reviewStudentRecord: (...args: unknown[]) => mockReviewStudentRecord(...args),
  captureScoreFromText: (...args: unknown[]) => mockCaptureScoreFromText(...args),
  captureCommunicationFromText: (...args: unknown[]) => mockCaptureCommunicationFromText(...args),
  updateCommunicationDetail: (...args: unknown[]) => mockUpdateCommunicationDetail(...args),
}));

const teacherId = 'teacher-1';
const studentId = 'student-1';
const onNavigate = vi.fn();

const mockStudent = {
  id: studentId,
  teacherId,
  name: '张三',
  grade: '高一(3)班',
  source: '推荐',
  currentStatus: 'active',
  stageGoal: '期末考试进入前10名',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-01T00:00:00Z',
};

const mockTimelineItems = [
  {
    type: 'assessment' as const,
    id: 'a1',
    occurredAt: '2024-10-01T08:00:00Z',
    title: '物理月考成绩',
    summary: '月考物理成绩发布',
    category: 'assessment',
    reviewStatus: 'confirmed',
    visibility: 'parent_shareable',
    status: null,
    score: 83,
    fullScore: 100,
    examName: '月考',
    subject: '物理',
    communicationDetail: null,
  },
  {
    type: 'record' as const,
    id: 'c1',
    occurredAt: '2024-09-25T15:00:00Z',
    title: '家长电话沟通',
    summary: '小强妈妈来电沟通作业量问题',
    category: 'parent_communication',
    reviewStatus: 'confirmed',
    visibility: 'internal_only',
    status: null,
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: {
      direction: 'inbound',
      channel: 'phone',
      parentType: 'normal',
      parentConcerns: ['作业太多，孩子做到很晚', '担心休息时间不够'],
      teacherResponses: ['已了解，会适当调整作业量', '建议孩子提高效率'],
      agreements: ['下周适当减少作业量', '观察一周后再反馈'],
      followUps: ['下周一电话回访'],
      nextContactAtTs: '2024-10-01T10:00:00Z',
      moderationFlagged: null,
      moderationReasons: null,
    },
  },
  {
    type: 'record' as const,
    id: 'r1',
    occurredAt: '2024-09-20T10:00:00Z',
    title: '课堂表现',
    summary: '本周课堂参与积极',
    category: 'lesson_observation',
    reviewStatus: 'candidate',
    visibility: 'internal_only',
    status: null,
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: null,
  },
  {
    type: 'lesson' as const,
    id: 'l1',
    occurredAt: '2024-09-15T14:00:00Z',
    title: '第3次课',
    summary: '力学基础讲解',
    category: null,
    reviewStatus: null,
    visibility: null,
    status: 'attended',
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: null,
  },
  {
    type: 'feedback' as const,
    id: 'f1',
    occurredAt: '2024-09-10T09:00:00Z',
    title: '家长反馈',
    summary: '家长确认收到本周学习报告',
    category: null,
    reviewStatus: null,
    visibility: null,
    status: 'sent',
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: null,
  },
];

const mockRecords = [
  {
    id: 'rec-1',
    teacherId,
    studentId,
    sourceRecordId: 'src-1',
    category: 'lesson_observation',
    occurredAt: '2024-09-20T10:00:00Z',
    summary: '本周课堂参与积极，作业完成质量较高',
    structuredData: null,
    confidence: 'high',
    reviewStatus: 'candidate',
    visibility: 'internal_only',
    importance: 'normal',
    supersedesId: null,
    createdAt: '2024-09-20T10:00:00Z',
    updatedAt: '2024-09-20T10:00:00Z',
  },
  {
    id: 'rec-2',
    teacherId,
    studentId,
    sourceRecordId: 'src-2',
    category: 'general_note',
    occurredAt: '2024-08-15T08:00:00Z',
    summary: '已确认入学信息',
    structuredData: null,
    confidence: 'high',
    reviewStatus: 'confirmed',
    visibility: 'internal_only',
    importance: 'normal',
    supersedesId: null,
    createdAt: '2024-08-15T08:00:00Z',
    updatedAt: '2024-08-15T08:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockListStudents.mockResolvedValue({ items: [mockStudent], total: 1 });
  mockGetStudentTimeline.mockResolvedValue({ items: mockTimelineItems, total: mockTimelineItems.length });
  mockListStudentRecords.mockResolvedValue({ items: mockRecords, total: mockRecords.length });
});

function renderPage() {
  return render(
    <StudentDetailPage
      teacherId={teacherId}
      studentId={studentId}
      onNavigate={onNavigate}
    />,
  );
}

describe('StudentDetailPage', () => {
  // ---- 顶部概览 ----
  it('renders student overview with name, grade, status, stage goal and back link', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('张三')).toBeInTheDocument();
    });

    expect(screen.getByText(/高一\(3\)班/)).toBeInTheDocument();
    expect(screen.getByText('在读')).toBeInTheDocument();
    expect(screen.getByText(/期末考试进入前10名/)).toBeInTheDocument();

    const backButton = screen.getByRole('button', { name: /返回学生列表/ });
    expect(backButton).toBeInTheDocument();
    fireEvent.click(backButton);
    expect(onNavigate).toHaveBeenCalledWith('/students');
  });

  // ---- 时间线：多类型合并 + 倒序 + 状态徽标 ----
  it('renders timeline with multiple types, reverse chronological order and status badges', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    const timelineItems = screen.getAllByRole('listitem');

    // 时间线标题顺序应倒序：assessment(10月) -> 家长沟通(9/25) -> record(9/20) -> lesson(9/15) -> feedback(9/10)
    const titles = timelineItems.map((item) => {
      const h4 = item.querySelector('.timeline-title') || item.querySelector('h4');
      return h4?.textContent ?? '';
    });

    // 过滤出时间线条目（可能有成绩列表项和档案列表项）
    const timelineTitles = titles.filter((t) =>
      ['物理月考成绩', '家长电话沟通', '课堂表现', '第3次课', '家长反馈'].includes(t),
    );

    expect(timelineTitles[0]).toBe('物理月考成绩');
    expect(timelineTitles[1]).toBe('家长电话沟通');
    expect(timelineTitles[2]).toBe('课堂表现');
    expect(timelineTitles[3]).toBe('第3次课');
    expect(timelineTitles[4]).toBe('家长反馈');

    // 类型标签
    expect(screen.getByText('成绩')).toBeInTheDocument();
    expect(screen.getAllByText('档案').length).toBeGreaterThan(0);
    expect(screen.getByText('课次')).toBeInTheDocument();
    expect(screen.getByText('反馈')).toBeInTheDocument();

    // 状态徽标：已确认、待审核
    expect(screen.getAllByText('已确认').length).toBeGreaterThan(0);
    expect(screen.getAllByText('待审核').length).toBeGreaterThan(0);
  });

  // ---- 时间线：空状态 ----
  it('shows empty state when timeline is empty', async () => {
    mockGetStudentTimeline.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    expect(screen.getByText(/还没有记录，试试在上方粘贴一句话记成绩/)).toBeInTheDocument();
  });

  // ---- 时间线：失败 ----
  it('shows error state when timeline fails to load', async () => {
    mockGetStudentTimeline.mockRejectedValue(new Error('服务器内部错误'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/时间线加载失败：服务器内部错误/)).toBeInTheDocument();
    });
  });

  // ---- 成绩列表 ----
  it('renders assessment scores from timeline with previous score comparison', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '成绩记录' })).toBeInTheDocument();
    });

    // 成绩值（时间线和成绩列表都有，至少两处）
    expect(screen.getAllByText(/83\/100/).length).toBeGreaterThanOrEqual(2);
    // 考试名
    expect(screen.getAllByText('月考').length).toBeGreaterThan(0);
    // 科目
    expect(screen.getAllByText('物理').length).toBeGreaterThan(0);
  });

  // ---- 文字记成绩：成功 ----
  it('captures score from text successfully, shows archived message, and refreshes timeline', async () => {
    const mockCaptureResult = {
      studentId,
      extraction: {
        subject: '物理',
        score: 83,
        fullScore: 100,
        examName: '月考',
        previousScore: 78,
        confidence: 'high',
      },
      record: mockRecords[0],
      detail: {
        id: 'det-1',
        teacherId,
        studentRecordId: 'rec-new',
        examName: '月考',
        subject: '物理',
        examDate: '2024-10-01T00:00:00Z',
        score: 83,
        fullScore: 100,
        classRank: null,
        gradeRank: null,
        percentile: null,
        previousScore: 78,
        note: null,
        createdAt: '2024-10-01T00:00:00Z',
        updatedAt: '2024-10-01T00:00:00Z',
      },
      sourceRecord: {
        id: 'src-new',
        rawText: '物理月考 83/100，上次 78',
        captureStatus: 'captured',
      },
    };

    mockCaptureScoreFromText.mockResolvedValue(mockCaptureResult);
    // 第二次调用（刷新）返回更新后的数据
    mockGetStudentTimeline
      .mockResolvedValueOnce({ items: mockTimelineItems, total: mockTimelineItems.length })
      .mockResolvedValueOnce({
        items: [
          {
            type: 'assessment' as const,
            id: 'a-new',
            occurredAt: '2024-10-05T00:00:00Z',
            title: '物理月考（新）',
            summary: '新识别的成绩',
            category: 'assessment',
            reviewStatus: 'confirmed',
            visibility: 'parent_shareable',
            status: null,
            score: 83,
            fullScore: 100,
            examName: '月考',
            subject: '物理',
          },
          ...mockTimelineItems,
        ],
        total: mockTimelineItems.length + 1,
      });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '文字记成绩' })).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText('成绩文本');
    fireEvent.change(textarea, { target: { value: '物理月考 83/100，上次 78' } });

    const form = textarea.closest('form');
    const submitButton = form?.querySelector('button[type="submit"]');
    expect(submitButton).not.toBeNull();

    fireEvent.click(submitButton!);

    // 按钮禁用
    expect(submitButton).toBeDisabled();
    expect(mockCaptureScoreFromText).toHaveBeenCalledWith(
      teacherId,
      studentId,
      '物理月考 83/100，上次 78',
    );

    // 成功消息
    await waitFor(() => {
      expect(screen.getByText(/已归档：物理 83\/100 月考/)).toBeInTheDocument();
    });

    // 输入框清空
    expect(textarea).toHaveValue('');

    // 刷新了时间线（getStudentTimeline 被调用次数 > 1）
    expect(mockGetStudentTimeline).toHaveBeenCalledTimes(2);
  });

  // ---- 文字记成绩：失败 ----
  it('shows error message when capture fails', async () => {
    mockCaptureScoreFromText.mockRejectedValue(new Error('无法识别成绩信息，请补充科目和分数'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '文字记成绩' })).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText('成绩文本');
    fireEvent.change(textarea, { target: { value: '考得不错' } });

    const form = textarea.closest('form');
    const submitButton = form?.querySelector('button[type="submit"]');
    fireEvent.click(submitButton!);

    await waitFor(() => {
      expect(screen.getByText(/无法识别成绩信息，请补充科目和分数/)).toBeInTheDocument();
    });

    // 输入框不清空
    expect(textarea).toHaveValue('考得不错');
  });

  // ---- 审核：确认成功 ----
  it('confirms a pending record successfully and refreshes', async () => {
    const confirmedRecord = { ...mockRecords[0], reviewStatus: 'confirmed' };
    mockReviewStudentRecord.mockResolvedValue(confirmedRecord);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '档案审核' })).toBeInTheDocument();
    });

    // 确认按钮存在
    const confirmButtons = screen.getAllByRole('button', { name: /确认/ });
    expect(confirmButtons.length).toBeGreaterThan(0);

    // 点击第一个确认按钮
    fireEvent.click(confirmButtons[0]);

    expect(mockReviewStudentRecord).toHaveBeenCalledWith(
      teacherId,
      studentId,
      'rec-1',
      'confirmed',
      'parent_shareable',
    );

    // 时间线被刷新
    await waitFor(() => {
      expect(mockGetStudentTimeline).toHaveBeenCalledTimes(2);
    });
  });

  // ---- 审核：驳回成功 ----
  it('rejects a pending record successfully and refreshes', async () => {
    const rejectedRecord = { ...mockRecords[0], reviewStatus: 'rejected' };
    mockReviewStudentRecord.mockResolvedValue(rejectedRecord);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '档案审核' })).toBeInTheDocument();
    });

    const rejectButtons = screen.getAllByRole('button', { name: /驳回/ });
    expect(rejectButtons.length).toBeGreaterThan(0);

    fireEvent.click(rejectButtons[0]);

    expect(mockReviewStudentRecord).toHaveBeenCalledWith(
      teacherId,
      studentId,
      'rec-1',
      'rejected',
    );

    // 驳回不传 visibility（只有 4 个参数）
    const rejectCall = mockReviewStudentRecord.mock.calls.find(
      (call) => call[3] === 'rejected',
    );
    expect(rejectCall?.length).toBe(4);

    await waitFor(() => {
      expect(mockGetStudentTimeline).toHaveBeenCalledTimes(2);
    });
  });

  // ---- 跨老师：404 错误消息显示 ----
  it('shows error when student does not belong to teacher (404-like)', async () => {
    // 学生不在该老师的学生列表中
    mockListStudents.mockResolvedValue({ items: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/学生信息加载失败/)).toBeInTheDocument();
    });

    expect(screen.getByText(/未找到该学生（可能不属于当前老师）/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /返回学生列表/ })).toBeInTheDocument();
  });

  // ---- 学生加载失败 ----
  it('shows error when listStudents fails', async () => {
    mockListStudents.mockRejectedValue(new Error('网络连接失败'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/学生信息加载失败/)).toBeInTheDocument();
    });

    expect(screen.getByText(/网络连接失败/)).toBeInTheDocument();
  });

  // ---- 初始加载状态 ----
  it('shows loading state initially', () => {
    // 让 promise 暂不 resolve
    mockListStudents.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/正在加载学生信息/)).toBeInTheDocument();
  });

  // ---- 档案记录空状态 ----
  it('shows empty state for records when no records', async () => {
    mockListStudentRecords.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '档案审核' })).toBeInTheDocument();
    });

    expect(screen.getByText('还没有档案记录')).toBeInTheDocument();
  });

  // ---- 家长沟通：时间线渲染沟通卡片 ----
  it('renders communication card with Chinese labels, lists and next contact time', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    // 沟通徽标
    expect(screen.getAllByText('沟通').length).toBeGreaterThan(0);
    // 中文标签
    expect(screen.getByText('打进')).toBeInTheDocument();
    expect(screen.getByText('电话')).toBeInTheDocument();
    expect(screen.getByText('普通')).toBeInTheDocument();

    // 关注点列表
    expect(screen.getByText('关注点')).toBeInTheDocument();
    expect(screen.getByText('作业太多，孩子做到很晚')).toBeInTheDocument();
    expect(screen.getByText('担心休息时间不够')).toBeInTheDocument();

    // 回应列表
    expect(screen.getByText('回应')).toBeInTheDocument();
    expect(screen.getByText('已了解，会适当调整作业量')).toBeInTheDocument();

    // 共识列表
    expect(screen.getByText('共识')).toBeInTheDocument();
    expect(screen.getByText('下周适当减少作业量')).toBeInTheDocument();

    // 待办列表
    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('下周一电话回访')).toBeInTheDocument();

    // 下次联系时间
    expect(screen.getByText(/下次联系/)).toBeInTheDocument();

    // 编辑按钮
    const editButtons = screen.getAllByRole('button', { name: /编辑沟通记录/ });
    expect(editButtons.length).toBeGreaterThan(0);
  });

  // ---- 家长沟通：communicationDetail 为 null 时不崩 ----
  it('renders timeline items without communicationDetail without crash', async () => {
    // 课堂观察条目没有 communicationDetail，应该正常显示
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    // 课堂表现正常显示，没有渲染沟通卡片
    expect(screen.getByText('课堂表现')).toBeInTheDocument();
    // 检查只有一条沟通记录有「沟通」徽标
    const commBadges = screen.getAllByText('沟通');
    expect(commBadges.length).toBe(1);
  });

  // ---- 家长沟通：本地风险标记可见化（D51） ----
  it('shows risk badge and reasons when communication is moderation flagged', async () => {
    mockGetStudentTimeline.mockResolvedValue({
      items: [
        {
          type: 'record' as const,
          id: 'c-risk',
          occurredAt: '2024-09-26T09:00:00Z',
          title: '家长电话沟通（风险）',
          summary: '小强妈妈来电语气激烈',
          category: 'parent_communication',
          reviewStatus: 'confirmed',
          visibility: 'internal_only',
          status: null,
          score: null,
          fullScore: null,
          examName: null,
          subject: null,
          communicationDetail: {
            direction: 'inbound',
            channel: 'phone',
            parentType: 'sensitive',
            parentConcerns: ['孩子被同学欺负'],
            teacherResponses: ['已安抚，表示会跟进'],
            agreements: [],
            followUps: [],
            nextContactAtTs: null,
            moderationFlagged: true,
            moderationReasons: ['violence（暴力/威胁言论）', 'privacy（隐私泄露（手机号/身份证/敏感凭证））'],
          },
        },
      ],
      total: 1,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('家长电话沟通（风险）')).toBeInTheDocument();
    });

    // 风险标记徽标
    expect(screen.getByText('风险标记')).toBeInTheDocument();
    // 白名单原因原文展示
    expect(screen.getByText('violence（暴力/威胁言论）')).toBeInTheDocument();
    expect(screen.getByText('privacy（隐私泄露（手机号/身份证/敏感凭证））')).toBeInTheDocument();
  });

  it('hides risk badge when communication is not flagged or moderation not configured', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    // 默认 fixture：moderationFlagged = null（未配置），不应渲染风险标记
    expect(screen.queryByText('风险标记')).toBeNull();
  });

  // ---- 记家长沟通：成功 ----
  it('captures communication from text successfully, shows archived message, and refreshes', async () => {
    const mockCommResult = {
      studentId,
      extraction: {
        direction: 'outbound',
        channel: 'wechat',
        parentType: 'sensitive',
        parentConcerns: ['孩子最近情绪低落'],
        teacherResponses: ['建议多陪伴沟通'],
        agreements: [],
        followUps: ['周末电话回访'],
        nextContactAt: '2024-10-05T10:00:00Z',
        summary: '微信沟通孩子情绪问题',
        confidence: 'high',
      },
      record: {
        id: 'rec-comm-new',
        teacherId,
        studentId,
        sourceRecordId: null,
        category: 'parent_communication',
        occurredAt: '2024-09-28T10:00:00Z',
        summary: '微信沟通孩子情绪问题',
        structuredData: null,
        confidence: 'high',
        reviewStatus: 'auto_confirmed',
        visibility: 'internal_only',
        importance: 'normal',
        supersedesId: null,
        createdAt: '2024-09-28T10:00:00Z',
        updatedAt: '2024-09-28T10:00:00Z',
      },
      detail: {
        id: 'det-comm-new',
        teacherId,
        studentRecordId: 'rec-comm-new',
        direction: 'outbound',
        channel: 'wechat',
        parentType: 'sensitive',
        parentConcerns: ['孩子最近情绪低落'],
        teacherResponses: ['建议多陪伴沟通'],
        agreements: [],
        followUps: ['周末电话回访'],
        nextContactAtTs: '2024-10-05T10:00:00Z',
        createdAtTs: '2024-09-28T10:00:00Z',
        updatedAtTs: '2024-09-28T10:00:00Z',
      },
      sourceRecord: { id: 'src-comm-new' },
    };

    mockCaptureCommunicationFromText.mockResolvedValue(mockCommResult);
    mockGetStudentTimeline
      .mockResolvedValueOnce({ items: mockTimelineItems, total: mockTimelineItems.length })
      .mockResolvedValueOnce({ items: mockTimelineItems, total: mockTimelineItems.length });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '记家长沟通' })).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText('家长沟通文本');
    fireEvent.change(textarea, { target: { value: '小强妈妈打电话说作业太多，约了下周再聊' } });

    const form = textarea.closest('form');
    const commSubmitButton = form?.querySelector('button[type="submit"]');
    expect(commSubmitButton).not.toBeNull();

    fireEvent.click(commSubmitButton!);

    expect(commSubmitButton).toBeDisabled();
    expect(mockCaptureCommunicationFromText).toHaveBeenCalledWith(
      teacherId,
      studentId,
      { rawText: '小强妈妈打电话说作业太多，约了下周再聊' },
    );

    // 成功消息
    await waitFor(() => {
      expect(screen.getByText(/已归档：打出 微信 沟通/)).toBeInTheDocument();
    });

    // 输入框清空
    expect(textarea).toHaveValue('');

    // 刷新了时间线
    expect(mockGetStudentTimeline).toHaveBeenCalledTimes(2);
  });

  // ---- 记家长沟通：失败 ----
  it('shows error message when communication capture fails and preserves input', async () => {
    mockCaptureCommunicationFromText.mockRejectedValue(
      new Error('无法识别沟通内容，请补充方向和渠道'),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '记家长沟通' })).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText('家长沟通文本');
    fireEvent.change(textarea, { target: { value: '聊了聊孩子' } });

    const form = textarea.closest('form');
    const commSubmitButton = form?.querySelector('button[type="submit"]');
    fireEvent.click(commSubmitButton!);

    await waitFor(() => {
      expect(screen.getByText(/无法识别沟通内容，请补充方向和渠道/)).toBeInTheDocument();
    });

    // 输入框保留
    expect(textarea).toHaveValue('聊了聊孩子');
  });

  // ---- 编辑沟通：保存成功 ----
  it('edits communication and calls PATCH with correct params, then refreshes', async () => {
    const updatedDetail = {
      id: 'det-c1',
      teacherId,
      studentRecordId: 'c1',
      direction: 'two_way',
      channel: 'offline',
      parentType: 'scores',
      parentConcerns: ['更新后的关注点'],
      teacherResponses: ['更新后的回应'],
      agreements: ['更新后的共识'],
      followUps: ['更新后的待办'],
      nextContactAtTs: '2024-10-15T14:00:00Z',
      createdAtTs: '2024-09-25T15:00:00Z',
      updatedAtTs: '2024-09-26T10:00:00Z',
    };

    mockUpdateCommunicationDetail.mockResolvedValue(updatedDetail);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    // 点击编辑按钮
    const editButtons = screen.getAllByRole('button', { name: /编辑沟通记录/ });
    fireEvent.click(editButtons[0]);

    // 编辑表单出现
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();

    // 修改方向
    const dirSelect = screen.getByLabelText('方向');
    fireEvent.change(dirSelect, { target: { value: 'two_way' } });

    // 修改渠道
    const channelSelect = screen.getByLabelText('渠道');
    fireEvent.change(channelSelect, { target: { value: 'offline' } });

    // 修改关注点
    const concernsTextarea = screen.getByLabelText(/关注点/);
    fireEvent.change(concernsTextarea, { target: { value: '更新后的关注点' } });

    // 点击保存
    const saveButton = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveButton);

    // PATCH 参数正确
    await waitFor(() => {
      expect(mockUpdateCommunicationDetail).toHaveBeenCalledTimes(1);
    });

    const callArgs = mockUpdateCommunicationDetail.mock.calls[0];
    expect(callArgs[0]).toBe(teacherId);
    expect(callArgs[1]).toBe(studentId);
    expect(callArgs[2]).toBe('c1');
    expect(callArgs[3].direction).toBe('two_way');
    expect(callArgs[3].channel).toBe('offline');
    expect(callArgs[3].parentConcerns).toEqual(['更新后的关注点']);
    expect(Array.isArray(callArgs[3].teacherResponses)).toBe(true);
    expect(Array.isArray(callArgs[3].agreements)).toBe(true);
    expect(Array.isArray(callArgs[3].followUps)).toBe(true);

    // 时间线被刷新
    expect(mockGetStudentTimeline).toHaveBeenCalledTimes(2);
  });

  // ---- 编辑沟通：取消不调 PATCH ----
  it('cancels communication edit without calling PATCH', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '时间线' })).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole('button', { name: /编辑沟通记录/ });
    fireEvent.click(editButtons[0]);

    // 修改关注点
    const concernsTextarea = screen.getByLabelText(/关注点/);
    fireEvent.change(concernsTextarea, { target: { value: '随便改的东西' } });

    // 点击取消
    const cancelButton = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelButton);

    // 不调 PATCH
    expect(mockUpdateCommunicationDetail).not.toHaveBeenCalled();

    // 再次点开编辑，内容应该是原始值
    const editButtonsAfter = screen.getAllByRole('button', { name: /编辑沟通记录/ });
    fireEvent.click(editButtonsAfter[0]);

    const concernsTextareaAfter = screen.getByLabelText(/关注点/) as HTMLTextAreaElement;
    expect(concernsTextareaAfter.value).toContain('作业太多，孩子做到很晚');
  });
});
