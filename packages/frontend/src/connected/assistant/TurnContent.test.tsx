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
});
