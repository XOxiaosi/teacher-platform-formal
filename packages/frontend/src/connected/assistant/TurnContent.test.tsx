import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TurnContent } from './TurnContent';

describe('assistant turn presentation', () => {
  it('renders headings and tables instead of exposing markdown markers', () => {
    render(<TurnContent turn={{
      id: 'turn-1', conversationId: 'conversation-1', kind: 'assistant',
      content: '已查询完毕，说明如下。\n\n## 结果\n\n| 项目 | 状态 |\n| --- | --- |\n| 课次 | 待确认 |',
      createdAt: '2026-09-15T12:00:00Z', references: [],
    }} />);
    expect(screen.getByRole('heading', { name: '结果' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('## 结果')).not.toBeInTheDocument();
  });

  it('folds a repeated generated result inside one assistant turn', () => {
    const result = '已查询完毕，说明如下。\n\n## 结果\n\n内容已核对。';
    render(<TurnContent turn={{
      id: 'turn-2', conversationId: 'conversation-1', kind: 'assistant',
      content: `${result}\n\n${result}`, createdAt: '2026-09-15T12:00:00Z', references: [],
    }} />);
    expect(screen.getAllByRole('heading', { name: '结果' })).toHaveLength(1);
    expect(screen.getByText('（重复结果已折叠，以上结论保留一次。）')).toBeInTheDocument();
  });

  it('does not render the persisted presentation summary a second time', () => {
    const content = '已查询完毕，说明如下。';
    render(<TurnContent turn={{
      id: 'turn-3', conversationId: 'conversation-1', kind: 'assistant', content,
      createdAt: '2026-09-15T12:00:00Z', references: [],
      presentation: { schemaVersion: 1, summary: content, sections: [], references: [], actions: [] },
    }} />);
    expect(screen.getAllByText(content)).toHaveLength(1);
  });

  it('keeps historical or expired confirmations read-only', () => {
    render(<TurnContent turn={{
      id: 'confirmation-1', conversationId: 'conversation-1', kind: 'confirmation', actionId: 'old-action', actionName: 'scheduling.create',
      target: { type: 'Schedule', id: 'schedule-1' }, beforeSummary: null, afterSummary: '旧的排课提案', parameterSummary: {},
      status: 'pending', expiresAt: '2020-01-01T00:00:00Z', actionToken: 'not-rendered', error: null, createdAt: '2026-09-15T12:00:00Z',
    }} />);
    expect(screen.getByText('确认已过期，请重新提出要求并核对当前资料。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认保存' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('not-rendered');
  });

  it('shows a saved student result with a student route and no raw identifier', () => {
    render(<TurnContent turn={{
      id: 'tool-1', conversationId: 'conversation-1', kind: 'tool', toolCallId: 'call-1', toolName: 'students.create',
      displayName: '登记学生', sideEffect: 'create', status: 'success', inputSummary: {}, resultSummary: '学生小明已保存。',
      references: [{ type: 'Student', id: 'student-private-id', label: '小明', route: '/students/student-private-id' }], error: null,
      createdAt: '2026-09-15T12:00:00Z',
    }} />);
    expect(screen.getByText('学生小明已保存。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看学生' })).toHaveAttribute('href', '#/students/student-private-id');
    expect(document.body.textContent).not.toContain('student-private-id');
  });
});
