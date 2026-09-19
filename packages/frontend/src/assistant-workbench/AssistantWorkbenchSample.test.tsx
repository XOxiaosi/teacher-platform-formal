import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssistantWorkbenchSample } from './AssistantWorkbenchSample';

describe('assistant workbench visual sample', () => {
  beforeEach(() => { location.hash = '#/agent/sample-conversation'; });

  it('shows concrete saved, pending, incomplete, and unavailable states without a real API', async () => {
    render(<AssistantWorkbenchSample />);
    expect(await screen.findByText('学生小明已保存。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看学生' })).toHaveAttribute('href', '#/students/sample-student-ming');
    expect(screen.getByText(/小班参与名单尚待补充，补齐后再安排小班课程；我不会猜测或代填。/)).toBeInTheDocument();
    expect(screen.getByText('备忘未保存，可重试。')).toBeInTheDocument();
    expect(screen.getByText('班级自动匹配能力尚未接入。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
    expect(await screen.findByRole('heading', { name: '已保存' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看课表' })).toHaveAttribute('href', '#/schedules');
    expect(document.body.textContent).not.toContain('sample-only-confirmation-token');
    const input = screen.getByLabelText('交给教学助手的工作');
    fireEvent.change(input, { target: { value: '继续合成任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('heading', { name: '样板回复' })).toBeInTheDocument();
    expect(screen.queryByText('最新结果待写入会话')).not.toBeInTheDocument();
  });
});
