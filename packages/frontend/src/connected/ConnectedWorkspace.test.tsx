import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedWorkspace } from './ConnectedWorkspace';
import { createDemoData } from '../preview/data';
import { clearPendingPaymentRequests, readPendingPaymentRequest } from './payments/pending-payment';

const mock = vi.hoisted(() => ({ availability: vi.fn(), load: vi.fn(), command: vi.fn(), schedule: vi.fn(), payment: vi.fn(), balance: vi.fn(), ledger: vi.fn(), update: vi.fn(), logout: vi.fn(), records: vi.fn(), generate: vi.fn(), createFeedback: vi.fn(), updateFeedback: vi.fn(), feedbackSnapshot: vi.fn(), createDraftTask: vi.fn(), listDraftTasks: vi.fn(), getDraftTask: vi.fn(), retryDraftTask: vi.fn(), updateDraftTask: vi.fn(), prepareCorrection: vi.fn(), confirmCorrection: vi.fn() }));
vi.mock('../app/teacher-context', () => ({ useAuth: () => ({ teacherId: 'teacher-a', displayName: '验收老师', email: 'a@example.test', logout: mock.logout }) }));
vi.mock('./workspace-api', () => ({ loadWorkspace: mock.load, workspaceCommand: mock.command, schedulingCommand: mock.schedule }));
vi.mock('../api/payments', () => ({ createPayment: mock.payment, listLessonLedgerEntries: mock.ledger }));
vi.mock('../api/lesson-status-corrections', () => ({ prepareLessonStatusCorrection: mock.prepareCorrection, confirmLessonStatusCorrection: mock.confirmCorrection }));
vi.mock('../api/students', () => ({ updateStudentProfile: mock.update, getStudentBalance: mock.balance, listStudentRecords: mock.records, reviewStudentRecord: vi.fn(), getStudentRecordSource: vi.fn() }));
vi.mock('../api/feedback', () => ({ generateFeedbackDraft: mock.generate, createFeedback: mock.createFeedback, getFeedbackSnapshot: mock.feedbackSnapshot, updateFeedbackContent: mock.updateFeedback, createFeedbackDraftTask: mock.createDraftTask, listFeedbackDraftTasks: mock.listDraftTasks, getFeedbackDraftTask: mock.getDraftTask, retryFeedbackDraftTask: mock.retryDraftTask, updateFeedbackDraftTask: mock.updateDraftTask }));
vi.mock('../api/teaching-tasks', () => ({ getTeachingRuntimeAvailability: mock.availability }));
vi.mock('../connected/assistant', () => ({ AssistantWorkspace: ({ teacherId }: { teacherId: string }) => <section aria-label="正式教学助手入口"><h1>教学助手</h1><p>当前账号：{teacherId}</p></section> }));

const snapshot = () => ({ data: createDemoData(), studentVersions: { s1: 'v1', s2: 'v2' }, feedbackVersions: {}, memoVersions: { m1: 'm1-v1' }, preferenceVersion: null });
beforeEach(() => { vi.clearAllMocks(); clearPendingPaymentRequests('teacher-a'); mock.availability.mockResolvedValue({ runtimeAvailability: 'unavailable' }); location.hash = '#/students'; mock.load.mockResolvedValue(snapshot()); mock.command.mockResolvedValue({}); mock.schedule.mockResolvedValue({}); mock.balance.mockResolvedValue({ purchased: 8, attended: 1, adjustments: 2, remaining: 9 }); mock.ledger.mockResolvedValue([]); mock.listDraftTasks.mockResolvedValue({ items: [] }); mock.prepareCorrection.mockResolvedValue({ confirmation: { id: 'correction-1', status: 'pending', lessonId: 'lesson-1', studentId: 's1', fromStatus: 'attended', toStatus: 'absent', reason: '签到复核' }, balanceBefore: { purchased: 10, attended: 1, adjustments: 0, remaining: 9 }, balanceAfter: { purchased: 10, attended: 0, adjustments: 0, remaining: 10 }, plannedLedgerEntry: null }); mock.confirmCorrection.mockResolvedValue({ confirmation: { id: 'correction-1', status: 'confirmed' }, lesson: { id: 'lesson-1', studentId: 's1', status: 'absent', updatedAt: 'v2' }, balance: { purchased: 10, attended: 0, adjustments: 0, remaining: 10 } }); });

describe('connected workspace server-backed writes', () => {
  async function preparePayment(amount = '200') {
    fireEvent.click(screen.getByRole('button', { name: '登记缴费' }));
    fireEvent.change(screen.getByLabelText('学生', { selector: 'select' }), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText('增加课时'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
  }
  it('reuses the payment request after a lost receipt and starts a new key after success', async () => {
    location.hash = '#/finance';
    const state = snapshot(); state.data.businessDate = '2026-09-22'; mock.load.mockResolvedValue(state);
    mock.payment.mockRejectedValueOnce(new Error('回执未收到')).mockResolvedValue({ id: 'payment-saved' });
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '缴费课时' });
    await preparePayment();
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('回执未收到');
    expect(screen.queryByText('缴费已登记，课时已更新')).not.toBeInTheDocument();
    const first = mock.payment.mock.calls[0][1];
    expect(first).toEqual({ studentId: 's1', amount: 200, lessonCount: 2,
      paidAt: '2026-09-22T12:00:00+08:00', clientRequestId: expect.any(String) });
    expect(first.clientRequestId.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('缴费已登记，课时已更新');
    expect(mock.payment.mock.calls[1][1]).toEqual(first);
    await preparePayment();
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await waitFor(() => expect(mock.payment).toHaveBeenCalledTimes(3));
    expect(mock.payment.mock.calls[2][1].clientRequestId).not.toBe(first.clientRequestId);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('keeps an unknown payment key through edits, resolves conflicts, and rotates only after a receipt', async () => {
    location.hash = '#/finance';
    mock.payment
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockRejectedValueOnce(new Error('clientRequestId 已用于其他缴费内容'))
      .mockResolvedValue({ id: 'payment-replayed' });
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '缴费课时' });
    await preparePayment();
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('网络中断');
    const key = mock.payment.mock.calls[0][1].clientRequestId;
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('clientRequestId 已用于其他缴费内容');
    expect(mock.payment.mock.calls[1][1]).toEqual(expect.objectContaining({ amount: 300 }));
    expect(mock.payment.mock.calls[1][1].clientRequestId).toBe(key);
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('缴费已登记，课时已更新');
    expect(mock.payment.mock.calls[2][1]).toEqual(expect.objectContaining({ amount: 200, clientRequestId: key }));
    await preparePayment('200');
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await waitFor(() => expect(mock.payment).toHaveBeenCalledTimes(4));
    expect(mock.payment.mock.calls[3][1].clientRequestId).not.toBe(key);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('keeps an unresolved payment key after closing or leaving the page and clears it only after a receipt', async () => {
    location.hash = '#/finance';
    mock.payment
      .mockRejectedValueOnce(new Error('回执未知'))
      .mockRejectedValueOnce(new Error('回执仍未知'))
      .mockResolvedValue({ id: 'payment-replayed' });
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '缴费课时' });
    await preparePayment();
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('回执未知');
    const firstKey = mock.payment.mock.calls[0][1].clientRequestId;
    expect(readPendingPaymentRequest('teacher-a')?.clientRequestId).toBe(firstKey);

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '登记缴费' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已恢复原登记内容');
    expect(screen.getByLabelText('金额')).toHaveValue(200);
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('回执仍未知');
    expect(mock.payment.mock.calls[1][1].clientRequestId).toBe(firstKey);

    await act(async () => {
      location.hash = '#/today';
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await act(async () => {
      location.hash = '#/finance';
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { name: '缴费课时' });
    fireEvent.click(screen.getByRole('button', { name: '登记缴费' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已恢复原登记内容');
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('缴费已登记，课时已更新');

    expect(mock.payment.mock.calls[2][1].clientRequestId).toBe(firstKey);
    expect(readPendingPaymentRequest('teacher-a')).toBeNull();
  });
  it('restores an unresolved payment key after the workspace remounts', async () => {
    location.hash = '#/finance';
    const firstDay = snapshot(); firstDay.data.businessDate = '2026-09-22'; mock.load.mockResolvedValue(firstDay);
    mock.payment.mockRejectedValueOnce(new Error('页面刷新前回执未知')).mockResolvedValue({ id: 'payment-replayed' });
    const firstWorkspace = render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '缴费课时' });
    await preparePayment();
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('页面刷新前回执未知');
    const firstKey = mock.payment.mock.calls[0][1].clientRequestId;
    const firstPayload = mock.payment.mock.calls[0][1];
    expect(firstPayload.paidAt).toBe('2026-09-22T12:00:00+08:00');
    expect(readPendingPaymentRequest('teacher-a')?.clientRequestId).toBe(firstKey);

    const nextDay = snapshot(); nextDay.data.businessDate = '2026-09-23'; mock.load.mockResolvedValue(nextDay);
    firstWorkspace.unmount();
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '缴费课时' });
    fireEvent.click(screen.getByRole('button', { name: '登记缴费' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已恢复原登记内容');
    expect(screen.getByLabelText('金额')).toHaveValue(200);
    fireEvent.click(screen.getByRole('button', { name: '下一步确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }));
    await screen.findByText('缴费已登记，课时已更新');

    expect(mock.payment.mock.calls[1][1].clientRequestId).toBe(firstKey);
    expect(mock.payment.mock.calls[1][1]).toEqual(firstPayload);
    expect(readPendingPaymentRequest('teacher-a')).toBeNull();
  });
  it('connects feedback generation to an explicit save with evidence and request receipt', async () => {
    location.hash = '#/feedback';
    mock.createDraftTask.mockResolvedValue({ replayed: false, task: { id: 'task-1', studentId: 's1', status: 'succeeded', version: 1, attemptCount: 1, retryable: false, request: { studentId: 's1' }, draft: { title: '课堂进展', content: '小雨主动验算，下一次继续保持。' }, generation: { lessonIds: ['lesson-1'], rationale: '使用具体课堂行为。', evidence: [{ id: 'record-1', type: 'record', occurredAt: '2026-09-14T08:00:00Z', category: 'lesson_observation', summary: '主动验算' }], windowStart: '2026-09-14T08:00:00Z', windowEnd: '2026-09-14T10:00:00Z' }, error: null, savedFeedbackId: null, createdAt: '2026-09-14T08:00:00Z', updatedAt: '2026-09-14T08:00:00Z' } });
    mock.createFeedback.mockResolvedValue({ id: 'feedback-1', studentId: 's1', title: '课堂进展', content: '小雨主动验算，下一次继续保持。', status: 'draft' });
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '家长反馈' });
    fireEvent.click(screen.getByRole('button', { name: '新建反馈' }));
    fireEvent.change(screen.getByLabelText('选择学生'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: '根据教学记录生成反馈' }));
    await screen.findByDisplayValue('小雨主动验算，下一次继续保持。');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(mock.createFeedback).toHaveBeenCalledWith('teacher-a', expect.objectContaining({
      studentId: 's1', generationTaskId: 'task-1', clientRequestId: expect.any(String),
    })));
    expect(mock.createDraftTask).toHaveBeenCalledWith('teacher-a', expect.objectContaining({ studentId: 's1', clientRequestId: expect.any(String) }));
  });
  it('mounts complete server record details and reloads them with the workspace', async () => {
    location.hash = '#/students/s1';
    mock.records.mockResolvedValue({ items: [{
      id: 'record-server', teacherId: 'teacher-a', studentId: 's1', sourceRecordId: null,
      category: 'general_note', summary: '服务端完整记录全文', occurredAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
      reviewStatus: 'confirmed', visibility: 'internal_only', confidence: 'high', importance: 'normal',
      supersedesId: null, structuredData: null,
    }], total: 1 });
    render(<ConnectedWorkspace />);
    await screen.findByText('服务端完整记录全文');
    expect(mock.records).toHaveBeenCalledWith('teacher-a', 's1', expect.objectContaining({ page: 1 }));
    const before = mock.records.mock.calls.length;
    mock.load.mockResolvedValue(snapshot());
    fireEvent.keyDown(screen.getByRole('button', { name: '账号菜单' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '刷新资料' }));
    await waitFor(() => expect(mock.records.mock.calls.length).toBeGreaterThan(before));
  });
  it('mounts the authoritative balance and ledger only on the formal student detail', async () => {
    location.hash = '#/students/s1';
    mock.records.mockResolvedValue({ items: [], total: 0 });
    mock.balance.mockResolvedValue({ purchased: 8, attended: 1, adjustments: 2, remaining: 9 });
    mock.ledger.mockResolvedValue([{
      id: 'ledger-gift-1', teacherId: 'teacher-a', studentId: 's1', entryType: 'gift',
      lessonDelta: 2, amount: null, reason: '续课赠送', paymentId: null, lessonId: null,
      adjustmentConfirmationId: 'confirmation-1', clientRequestId: 'gift-1', createdAt: '2026-09-20T01:00:00.000Z',
    }]);
    render(<ConnectedWorkspace />);
    const ledger = await screen.findByRole('region', { name: '学生课时账户' });
    expect(ledger).toHaveTextContent('已购课时8');
    expect(ledger).toHaveTextContent('调整课时+2');
    expect(ledger).toHaveTextContent('当前剩余9课时');
    expect(ledger).toHaveTextContent('赠课');
    expect(ledger).toHaveTextContent('续课赠送');
    expect(mock.balance).toHaveBeenCalledWith('teacher-a', 's1');
    expect(mock.ledger).toHaveBeenCalledWith('teacher-a', { studentId: 's1' });
    expect(screen.queryByText(/完成课时记录/)).not.toBeInTheDocument();

    const before = mock.ledger.mock.calls.length;
    mock.load.mockResolvedValue(snapshot());
    fireEvent.keyDown(screen.getByRole('button', { name: '账号菜单' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '刷新资料' }));
    await waitFor(() => expect(mock.ledger.mock.calls.length).toBeGreaterThan(before));
  });
  it.each([
    ['available', '教学 AI 已启用'], ['unavailable', '服务暂不可用'], ['test_only', '真实模型未启用'],
  ])('shows the server capability %s without exposing provider credentials to teachers', async (runtimeAvailability, label) => {
    mock.availability.mockResolvedValue({ runtimeAvailability });
    location.hash = '#/settings/models';
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: 'AI 服务', level: 1 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(label));
    expect(mock.availability).toHaveBeenCalledWith('teacher-a');
    expect(screen.getByRole('heading', { name: 'DeepSeek 服务' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加 API|保存 API/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key|供应商|API 地址|协议|模型 ID/)).not.toBeInTheDocument();
    expect(screen.queryByText('提交演示配置')).not.toBeInTheDocument();
  });
  it('mounts the formal assistant entry for the authenticated teacher', async () => {
    location.hash = '#/agent';
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '教学助手' });
    expect(screen.getByRole('region', { name: '正式教学助手入口' })).toHaveTextContent('当前账号：teacher-a');
  });
  it('waits for the server before closing a student form and reloads canonical data', async () => {
    let resolveWrite!: () => void;
    mock.command.mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '服务器学生' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('inert');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    expect(screen.queryByText('学生已添加')).not.toBeInTheDocument();
    expect(screen.getByText('正在处理，请稍候…')).toBeInTheDocument();
    expect(mock.command).toHaveBeenCalledWith('students', expect.objectContaining({ name: '服务器学生', grade: '初一', clientRequestId: expect.any(String) }));
    const next = snapshot(); next.data.students.push({ id: 'server-id', name: '服务器学生', grade: '初一', balance: 0, notes: [] }); mock.load.mockResolvedValue(next);
    await act(async () => resolveWrite());
    await screen.findByText('学生已添加');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('服务器学生')).toBeInTheDocument();
  });
  it('keeps input on failure and reuses the request key when the same operation is retried', async () => {
    mock.command.mockRejectedValue(new Error('网络暂时不可用'));
    render(<ConnectedWorkspace />); await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '保留输入' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初三' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('网络暂时不可用');
    expect(screen.getByLabelText('姓名')).toHaveValue('保留输入');
    expect(screen.queryByText('学生已添加')).not.toBeInTheDocument();
    const key = mock.command.mock.calls[0][1].clientRequestId;
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1].clientRequestId).toBe(key);
  });
  it('does not show synthetic fallback data when the backend is unavailable', async () => {
    mock.load.mockRejectedValue(new Error('后端不可达'));
    render(<ConnectedWorkspace />);
    await screen.findByRole('alert');
    expect(screen.queryByText('王浩然')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
  it('does not use local setData to toggle a saved memo', async () => {
    location.hash = '#/today'; render(<ConnectedWorkspace />);
    const checkbox = await screen.findByRole('checkbox', { name: '确认本周空闲时段' });
    fireEvent.click(checkbox);
    await waitFor(() => expect(mock.command).toHaveBeenCalledWith('memo-status', expect.objectContaining({ id: 'm1', done: true, expectedUpdatedAt: 'm1-v1' })));
  });
  it('saves a course sourced from an existing row as a fresh scheduling command without completion or payment', async () => {
    location.hash = '#/schedules';
    const state = snapshot();
    state.data.businessDate = '2026-09-22';
    const source = { ...state.data.schedules[0], id: 'saved-source', day: '2026-09-18', start: '14:00', end: '16:00', location: '线上工作室', participants: ['s2'], format: '一对一' as const, note: '保留课前准备', status: '已完成' as const, version: 'source-version', recurrenceRuleId: 'rule-source', recurrenceDay: '2026-09-18' };
    state.data.schedules = [source];
    mock.load.mockResolvedValue(state);
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增排期' }));
    fireEvent.click(screen.getByLabelText('选用已有课程'));
    fireEvent.change(screen.getByLabelText('已有课程'), { target: { value: source.id } });
    expect(screen.getByLabelText('日期')).toHaveValue('2026-09-22');
    expect(screen.getByLabelText('开始时间')).toHaveValue('14:00');
    expect(screen.getByLabelText('结束时间')).toHaveValue('16:00');
    expect(screen.getByLabelText('地点')).toHaveValue('线上工作室');
    fireEvent.click(screen.getByRole('button', { name: '保存排期' }));
    await waitFor(() => expect(mock.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'save-schedule',
      schedule: expect.objectContaining({ day: '2026-09-22', start: '14:00', end: '16:00', location: '线上工作室', participants: ['s2'], format: '一对一', note: '保留课前准备', status: '已排期' }),
    })));
    const saved = mock.schedule.mock.calls[0][0].schedule;
    expect(saved.id).not.toBe(source.id);
    expect(saved).not.toHaveProperty('createdAt');
    expect(saved).not.toHaveProperty('version');
    expect(saved).not.toHaveProperty('recurrenceRuleId');
    expect(mock.payment).not.toHaveBeenCalled();
    expect(mock.schedule.mock.calls.some(([payload]) => payload.kind === 'complete')).toBe(false);
  });
  it('keeps a drag-equivalent reschedule local until confirmation and does not show success after a scheduling failure', async () => {
    location.hash = '#/schedules';
    const state = snapshot();
    const schedule = { ...state.data.schedules[1], day: '2026-09-22', start: '14:00', end: '15:30' };
    state.data = { ...state.data, businessDate: '2026-09-22', schedules: [schedule], recurrenceRules: [] };
    mock.load.mockResolvedValue(state);
    mock.schedule.mockRejectedValueOnce(new Error('服务端冲突'));
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-09-23' } });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '10:15' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '11:45' } });
    expect(mock.schedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认仅本次修改' }));
    await screen.findByText('服务端冲突');
    expect(mock.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'save-schedule', schedule: expect.objectContaining({ id: schedule.id, day: '2026-09-23', start: '10:15', end: '11:45', status: '已排期' }),
    }));
    expect(mock.schedule.mock.calls.some(([payload]) => payload.kind === 'complete')).toBe(false);
    expect(screen.queryByText('已保存课程修改')).not.toBeInTheDocument();
  });
  it('routes a completed drag-equivalent reschedule through the revision command without re-completing it', async () => {
    location.hash = '#/schedules';
    const state = snapshot();
    const schedule = { ...state.data.schedules[0], day: '2026-09-22', start: '14:00', end: '15:30', status: '已完成' as const };
    state.data = { ...state.data, businessDate: '2026-09-22', schedules: [schedule], recurrenceRules: [] };
    mock.load.mockResolvedValue(state);
    mock.schedule.mockRejectedValueOnce(new Error('修订冲突'));
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑课程' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-09-23' } });
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '10:15' } });
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '11:45' } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    await screen.findByText('修订冲突');
    expect(mock.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'edit-completed', before: schedule,
      schedule: expect.objectContaining({ id: schedule.id, day: '2026-09-23', start: '10:15', end: '11:45', status: '已完成' }),
    }));
    expect(mock.schedule.mock.calls.some(([payload]) => payload.kind === 'save-schedule' || payload.kind === 'complete')).toBe(false);
    expect(screen.queryByText('已保存课程修订；未重新扣课。')).not.toBeInTheDocument();
  });
  it('previews attendance correction without reload and reloads only after confirmation', async () => {
    location.hash = '#/schedules';
    const state = snapshot();
    const schedule = { ...state.data.schedules[0], status: '已完成' as const, attendance: [{ lessonId: 'lesson-1', studentId: 's1', status: 'attended' as const, updatedAt: 'v1' }] };
    state.data = { ...state.data, schedules: [schedule], recurrenceRules: [] };
    mock.load.mockResolvedValue(state);
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getByRole('button', { name: /查看 09:00 至 10:30/ }));
    fireEvent.click(screen.getByRole('button', { name: '更正李雨桐的出勤状态' }));
    fireEvent.change(screen.getByLabelText('更正原因（必填）'), { target: { value: '签到复核' } });
    fireEvent.click(screen.getByRole('button', { name: '查看影响预览' }));
    await screen.findByText('9 → 10（+1）');
    expect(mock.prepareCorrection).toHaveBeenCalledWith(expect.objectContaining({ lessonId: 'lesson-1', targetStatus: 'absent', reason: '签到复核', clientRequestId: expect.any(String) }));
    expect(mock.load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '确认更正' }));
    await waitFor(() => expect(mock.confirmCorrection).toHaveBeenCalledWith('correction-1'));
    await waitFor(() => expect(mock.load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('出勤状态更正已保存')).toBeInTheDocument();
  });
  it('sends a future recurrence move with the original occurrence boundary and target replacement start', async () => {
    location.hash = '#/schedules';
    const originalDay = '2026-10-05';
    const targetDay = '2026-10-07';
    const state = snapshot();
    state.data = {
      ...state.data,
      businessDate: originalDay,
      schedules: [],
      recurrenceRules: [{ id: 'rr-future-move', startDate: originalDay, weekdays: [1, 5], enabled: true, start: '16:30', end: '18:00', location: '工作室 B', participants: ['s2', 's3'], format: '小班', note: '原备注', updatedAt: 'rule-v1' }],
    };
    mock.load.mockResolvedValue(state);
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getAllByRole('button', { name: /查看 16:30 至 18:00/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '本次及以后' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: targetDay } });
    fireEvent.click(screen.getByRole('button', { name: '查看修改确认' }));
    expect(screen.getByText(/旧重复规则自 2026年10月5日 停止，新规则从 2026年10月7日 起开始。/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认本次及以后修改' }));
    await waitFor(() => expect(mock.schedule).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'replace-rule',
      ruleId: 'rr-future-move',
      from: originalDay,
      expectedUpdatedAt: 'rule-v1',
      rule: expect.objectContaining({ startDate: targetDay, weekdays: [3, 5] }),
    })));
  });
  it('blocks further writes when a successful save cannot reload its canonical result', async () => {
    render(<ConnectedWorkspace />); await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '已写入数据库' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    mock.load.mockRejectedValue(new Error('刷新失败'));
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('操作已保存，但最新资料加载失败。请刷新资料核对，不要重复登记。');
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '第二次修改' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('请先点击“刷新资料”核对已保存的操作，再继续修改。');
    expect(mock.command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    mock.load.mockResolvedValue(snapshot());
    fireEvent.keyDown(screen.getByRole('button', { name: '账号菜单' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '刷新资料' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('keeps connected completion unavailable without sending the legacy complete command', async () => {
    location.hash = '#/schedules';
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '日程安排' });
    fireEvent.click(screen.getByRole('button', { name: /查看 14:00 至 15:30 小班 · 2 人.*排期详情/ }));
    expect(screen.getByRole('note')).toHaveTextContent('完课前需核对每位学生的实际出勤、拟扣课时和余额变化；当前暂不能确认完课。');
    expect(screen.queryByRole('button', { name: '完成并确认' })).not.toBeInTheDocument();
    expect(mock.schedule).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'complete' }));
  });
});
