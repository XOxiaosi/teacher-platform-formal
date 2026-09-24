import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPage } from './FeedbackSettings';
import { createDemoData } from './data';
import type { PreviewActions } from './PreviewApp';
import type { FeedbackDraftTask } from '../contracts/feedback-draft';

beforeEach(() => {
  location.hash = '#/feedback';
});

function Harness({ empty = true, taskActions = {} }: { empty?: boolean; taskActions?: Partial<PreviewActions> }) {
  const seed = createDemoData();
  const [data, setData] = useState(empty ? { ...seed, feedbacks: [] } : seed);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [dialog, setDialog] = useState<ReactNode>(null);
  const actions: PreviewActions = { data, setData, ui, setUi, open: (_title, body) => setDialog(body), toast: vi.fn(), close: () => setDialog(null), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(), ...taskActions };
  return <><FeedbackPage actions={actions} />{dialog && <div role="dialog">{dialog}</div>}</>;
}

function EvidenceHarness({ loadSnapshot }: { loadSnapshot: () => Promise<unknown> }) {
  const [dialog, setDialog] = useState<ReactNode>(null);
  const actions: PreviewActions = { data: createDemoData(), setData: vi.fn(), ui: {}, setUi: vi.fn(), open: (_title, body) => setDialog(body), toast: vi.fn(), close: () => setDialog(null), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(), viewFeedbackSnapshot: loadSnapshot as PreviewActions['viewFeedbackSnapshot'] };
  return <><FeedbackPage actions={actions} />{dialog && <div role="dialog">{dialog}</div>}</>;
}

describe('feedback settings', () => {
  it('offers an empty-state entry and saves a trimmed feedback for a selected student', async () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    fireEvent.change(screen.getByLabelText('选择学生'), { target: { value: 's2' } });
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  课后反馈  ' } });
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '第一段\n\n第二段' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await screen.findByText('课后反馈');
    expect(screen.getByText(/第一段/)).toBeInTheDocument();
    expect(screen.getByText(/王浩然 · 草稿/)).toBeInTheDocument();
  });

  it('rejects blank student, title, or body without saving', () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    expect(screen.getByRole('alert')).toHaveTextContent('不能为空');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('formats generated evidence window as readable Shanghai dates', async () => {
    const create = vi.fn().mockResolvedValue({ replayed: false, task: generatedTask() });
    render(<Harness taskActions={{ createFeedbackDraftTask: create }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    fireEvent.change(screen.getByLabelText('选择学生'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: '根据教学记录生成反馈' }));
    expect(await screen.findByText('本次使用 1 条已核对依据，范围 2026年8月18日 至 2026年9月17日。')).toBeInTheDocument();
    expect(screen.queryByText(/T17:28:13/)).not.toBeInTheDocument();
  });

  it('carries the confirmed record into the feedback draft and scopes generation to it', async () => {
    location.hash = '#/feedback?studentId=s2&recordId=record-1';
    const create = vi.fn().mockResolvedValue({ replayed: false, task: generatedTask() });
    render(<Harness taskActions={{ createFeedbackDraftTask: create }} />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    expect(screen.getByLabelText('选择学生')).toHaveValue('s2');
    expect(screen.getByText('已带入刚刚核对的正式记录，生成时只使用这条记录作为依据。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '根据教学记录生成反馈' }));
    await screen.findByLabelText('反馈生成依据');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ studentId: 's2', recordIds: ['record-1'], clientRequestId: expect.any(String) }));
  });

  it('opens the saved evidence snapshot so the teacher can review the source', async () => {
    const loadSnapshot = vi.fn().mockResolvedValue({
      feedbackId: 'f1', windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-09-02T00:00:00Z', assembledAt: '2026-09-02T08:00:00Z',
      evidence: [{ id: 'record-1', type: 'record' as const, occurredAt: '2026-09-01T08:00:00Z', category: 'lesson_observation', summary: '主动验算', examName: null, subject: '数学', score: null, fullScore: null, previousScore: null }],
    });
    render(<EvidenceHarness loadSnapshot={loadSnapshot} />);
    fireEvent.click(screen.getByRole('button', { name: '查看依据' }));
    expect(await screen.findByRole('list', { name: '反馈依据列表' })).toBeInTheDocument();
    expect(screen.getByText('主动验算')).toBeInTheDocument();
    expect(screen.getByText(/科目：数学/)).toBeInTheDocument();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('restores a failed server task, preserves its input, and starts a new retry after a failed receipt', async () => {
    const failed = (version: number): FeedbackDraftTask => ({
      id: 'task-failed', studentId: 's2', status: 'failed', version, attemptCount: version, retryable: true,
      request: { studentId: 's2', title: '原始标题', content: '原始正文' }, draft: null, generation: null,
      error: { code: 'MODEL_UNAVAILABLE', message: '模型暂不可用' }, savedFeedbackId: null,
      createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
    });
    const retry = vi.fn()
      .mockResolvedValueOnce({ task: failed(2), replayed: false })
      .mockResolvedValueOnce({ task: { ...failed(3), status: 'succeeded', retryable: false, draft: { title: '新标题', content: '新正文' }, generation: { lessonIds: [], rationale: '已完成' } }, replayed: false });
    render(<Harness taskActions={{ listFeedbackDraftTasks: vi.fn().mockResolvedValue([failed(1)]), retryFeedbackDraftTask: retry }} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(screen.getByDisplayValue('原始正文')).toBeInTheDocument();
    expect(screen.getByLabelText('选择学生')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试生成' }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '重试生成' }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(retry.mock.calls[0][1].clientRequestId).not.toBe(retry.mock.calls[1][1].clientRequestId);
    expect(screen.getByDisplayValue('新正文')).toBeInTheDocument();
  });

  it('blocks formal save from a running task and keeps pure manual feedback compatible', async () => {
    const running: FeedbackDraftTask = { id: 'task-running', studentId: 's2', status: 'running', version: 1, attemptCount: 1, retryable: false, request: { studentId: 's2', title: '处理中', content: '等待结果' }, draft: null, generation: null, error: null, savedFeedbackId: null, createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z' };
    render(<Harness taskActions={{ listFeedbackDraftTasks: vi.fn().mockResolvedValue([running]) }} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在由服务端生成反馈');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  });

  it('keeps teacher edits when a running-task poll returns a server result', async () => {
    const running: FeedbackDraftTask = { id: 'task-poll', studentId: 's2', status: 'running', version: 1, attemptCount: 1, retryable: false, request: { studentId: 's2', title: '处理中', content: '等待结果' }, draft: null, generation: null, error: null, savedFeedbackId: null, createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z' };
    let resolvePoll!: (task: FeedbackDraftTask) => void;
    const poll = vi.fn(() => new Promise<FeedbackDraftTask>((resolve) => { resolvePoll = resolve; }));
    render(<Harness taskActions={{ listFeedbackDraftTasks: vi.fn().mockResolvedValue([running]), getFeedbackDraftTask: poll, updateFeedbackDraftTask: vi.fn() }} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '教师正在修改的标题' } });
    resolvePoll({ ...running, status: 'succeeded', version: 2, draft: { title: '服务端生成标题', content: '服务端生成正文' }, generation: { lessonIds: [], rationale: '生成完成' } });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('教师正在修改的标题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂存修改' })).toBeInTheDocument();
  });
});

function generatedTask(): FeedbackDraftTask {
  return {
    id: 'task-generated', studentId: 's2', status: 'succeeded', version: 2, attemptCount: 1, retryable: false,
    request: { studentId: 's2' }, draft: { title: '课堂进展', content: '小雨主动验算，下一次继续保持。' },
    generation: { lessonIds: ['lesson-1'], rationale: '使用具体课堂行为。', evidence: [{ id: 'record-1', type: 'record', occurredAt: '2026-09-14T08:00:00Z', category: 'lesson_observation', summary: '主动验算', examName: null, subject: null, score: null, fullScore: null, previousScore: null }], windowStart: '2026-08-17T17:28:13.335Z', windowEnd: '2026-09-16T17:28:13.335Z' },
    error: null, savedFeedbackId: null, createdAt: '2026-09-16T17:28:13.335Z', updatedAt: '2026-09-16T17:28:13.335Z',
  };
}
