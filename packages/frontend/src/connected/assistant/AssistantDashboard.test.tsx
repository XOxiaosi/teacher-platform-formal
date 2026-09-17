import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantDashboard } from './AssistantDashboard';
import { createDemoData } from '../../preview/data';

describe('assistant work board', () => {
  it('summarises real workspace data and keeps the unavailable state explicit', () => {
    const data = createDemoData();
    render(<AssistantDashboard data={data} />);

    expect(screen.getByRole('heading', { name: '工作看板' })).toBeInTheDocument();
    expect(screen.getByText('AI 服务尚不可用')).toBeInTheDocument();
    expect(screen.getByText('今日课程')).toBeInTheDocument();
    expect(screen.getByText('待补充')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /查看全部/ })).toHaveAttribute('href', '#/today');
    expect(screen.getByRole('link', { name: /李雨桐/ })).toHaveAttribute('href', '#/students/s1');
  });

  it('renders safe zero states when loaded without a workspace snapshot', () => {
    render(<AssistantDashboard />);
    expect(screen.getByText('今日课程')).toBeInTheDocument();
    expect(screen.getAllByText('0', { selector: 'strong' })).toHaveLength(4);
    expect(screen.getByText('AI 服务尚不可用')).toBeInTheDocument();
  });
});
