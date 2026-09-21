import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPage } from './FeedbackSettings';
import { createDemoData } from './data';
import type { PreviewActions } from './PreviewApp';

const generateDraft = vi.fn();

beforeEach(() => {
  location.hash = '#/feedback';
  generateDraft.mockReset();
  generateDraft.mockImplementation(async ({ studentId, recordIds }: { studentId: string; recordIds?: string[] }) => ({ studentId, recordIds, lessonIds: ['lesson-1'], title: '课堂进展', content: '小雨主动验算，下一次继续保持。', source: 'ai' as const, rationale: '使用具体课堂行为。', evidence: [{ id: 'record-1', type: 'record' as const, occurredAt: '2026-09-14T08:00:00Z', category: 'lesson_observation', summary: '主动验算', examName: null, subject: null, score: null, fullScore: null, previousScore: null }], windowStart: '2026-08-17T17:28:13.335Z', windowEnd: '2026-09-16T17:28:13.335Z' }));
});

function Harness({ empty = true, generator = false }: { empty?: boolean; generator?: boolean }) {
  const seed = createDemoData();
  const [data, setData] = useState(empty ? { ...seed, feedbacks: [] } : seed);
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [dialog, setDialog] = useState<ReactNode>(null);
  const actions: PreviewActions = { data, setData, ui, setUi, open: (_title, body) => setDialog(body), toast: vi.fn(), close: () => setDialog(null), complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(), ...(generator ? { generateFeedbackDraft: generateDraft } : {}) };
  return <><FeedbackPage actions={actions} />{dialog && <div role="dialog">{dialog}</div>}</>;
}

describe('feedback settings', () => {
  it('offers an empty-state entry and saves a trimmed feedback for a selected student', () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    fireEvent.change(screen.getByLabelText('选择学生'), { target: { value: 's2' } });
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  课后反馈  ' } });
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '第一段\n\n第二段' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    expect(screen.getByText('课后反馈')).toBeInTheDocument();
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
    render(<Harness generator />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    fireEvent.change(screen.getByLabelText('选择学生'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: '根据教学记录生成反馈' }));
    expect(await screen.findByText('本次使用 1 条已核对依据，范围 2026年8月18日 至 2026年9月17日。')).toBeInTheDocument();
    expect(screen.queryByText(/T17:28:13/)).not.toBeInTheDocument();
  });

  it('carries the confirmed record into the feedback draft and scopes generation to it', async () => {
    location.hash = '#/feedback?studentId=s2&recordId=record-1';
    render(<Harness generator />);
    fireEvent.click(screen.getAllByRole('button', { name: '新建反馈' })[0]);
    expect(screen.getByLabelText('选择学生')).toHaveValue('s2');
    expect(screen.getByText('已带入刚刚核对的正式记录，生成时只使用这条记录作为依据。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '根据教学记录生成反馈' }));
    await screen.findByLabelText('反馈生成依据');
    expect(generateDraft).toHaveBeenCalledWith({ studentId: 's2', recordIds: ['record-1'] });
  });
});
