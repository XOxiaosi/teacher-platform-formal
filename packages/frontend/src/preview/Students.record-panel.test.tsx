import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudentPages } from './Students';
import { createDemoData } from './data';
import type { PreviewActions } from './PreviewApp';

function actions(): PreviewActions {
  return {
    data: createDemoData(), setData: vi.fn(), ui: {}, setUi: vi.fn(), open: vi.fn(), toast: vi.fn(), close: vi.fn(),
    complete: vi.fn(), saveSchedule: vi.fn(), cancelSchedule: vi.fn(), saveRule: vi.fn(), replaceRuleFrom: vi.fn(), setRuleEnabled: vi.fn(), addPayment: vi.fn(),
  };
}
describe('student detail record panel slot', () => {
  it('preserves preview records when no slot is passed', () => {
    render(<StudentPages actions={actions()} studentId="s2" />);
    expect(screen.getByText('课时余额较低，请留意')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '未来排期' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存记录' })).toBeInTheDocument();
  });
  it('renders only the selected student slot while preserving the composer and schedules', () => {
    const renderPanel = vi.fn((studentId: string) => <section>正式记录 {studentId}</section>);
    const view = render(<StudentPages actions={actions()} studentId="s2" recordPanel={renderPanel} />);
    expect(screen.getByText('正式记录 s2')).toBeInTheDocument();
    expect(screen.queryByText('课时余额较低，请留意')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存记录' })).toBeInTheDocument(); expect(screen.getByRole('heading', { name: '未来排期' })).toBeInTheDocument();
    view.rerender(<StudentPages actions={actions()} studentId="s1" recordPanel={renderPanel} />);
    expect(screen.getByText('正式记录 s1')).toBeInTheDocument(); expect(screen.queryByText('正式记录 s2')).not.toBeInTheDocument();
  });
});
