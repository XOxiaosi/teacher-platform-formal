import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssistantWorkbenchSample } from './AssistantWorkbenchSample';

describe('assistant workbench visual sample', () => {
  beforeEach(() => { location.hash = '#/agent/sample-conversation'; });

  it('shows business outcomes and confirmation without exposing internal task summaries', async () => {
    render(<AssistantWorkbenchSample />);
    expect(await screen.findByText('学生小明已保存。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看学生' })).toHaveAttribute('href', '#/students/sample-student-ming');
    expect(screen.getByText(/小班参与名单尚待补充，补齐后再安排小班课程；我不会猜测或代填。/)).toBeInTheDocument();
    expect(screen.getByText(/备忘保存失败，当前没有写入；可重试。/)).toBeInTheDocument();
    expect(screen.queryByText('备忘未保存，可重试。')).not.toBeInTheDocument();
    expect(screen.queryByText('班级自动匹配能力尚未接入。')).not.toBeInTheDocument();
    expect(screen.queryByText(/处理过程|正在处理|历史处理过程/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '演示确认' }));
    expect(await screen.findByRole('heading', { name: '演示已确认' })).toBeInTheDocument();
    expect(screen.getByText('演示已确认，未写入正式资料。')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '查看课表' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sample-only-confirmation-token');
    const input = screen.getByLabelText('交给教学助手的工作');
    fireEvent.change(input, { target: { value: '继续合成任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('heading', { name: '样板回复' })).toBeInTheDocument();
    expect(screen.queryByText('最新结果待写入会话')).not.toBeInTheDocument();
  });
});
