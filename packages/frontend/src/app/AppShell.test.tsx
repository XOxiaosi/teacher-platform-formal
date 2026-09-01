import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { demoMe, mockLogout, renderWithAuth } from '../test/render-with-auth';

// renderWithAuth 依赖模块级 auth api mock（me/logout 由测试助手控制）
vi.mock('../api/auth');

describe('AppShell', () => {
  it('渲染品牌、导航与 authed 老师身份（displayName）', async () => {
    renderWithAuth(
      <AppShell currentRoute="/agent" onNavigate={() => undefined}>测试内容</AppShell>,
      { meValue: demoMe },
    );

    expect(screen.getByRole('banner')).toHaveTextContent('教师 AI 工具平台');
    await screen.findByText('演示老师');
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '辅助导航' })).toBeInTheDocument();

    for (const label of ['Agent', '今日', '学生', '日程', '家长反馈', '财务', '变更记录', '设置', 'LLM 配置', '隐私与数据']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }

    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toHaveTextContent('测试内容');
    expect(screen.getByText('请使用至少 1180px 宽度的桌面窗口')).toBeInTheDocument();
  });

  it('currentRoute 改变后将焦点移入主内容', async () => {
    const { rerender } = renderWithAuth(
      <AppShell currentRoute="/agent" onNavigate={() => undefined}>Agent 内容</AppShell>,
      { meValue: demoMe },
    );
    await screen.findByText('演示老师');

    rerender(<AppShell currentRoute="/today" onNavigate={() => undefined}>今日内容</AppShell>);

    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('点击导航回传 canonical path', async () => {
    const onNavigate = vi.fn();
    renderWithAuth(
      <AppShell currentRoute="/agent" onNavigate={onNavigate}>测试内容</AppShell>,
      { meValue: demoMe },
    );
    await screen.findByText('演示老师');

    fireEvent.click(screen.getByRole('button', { name: '今日' }));

    expect(onNavigate).toHaveBeenCalledWith('/today');
  });

  it('点击「退出登录」调用 logout', async () => {
    const logoutMock = mockLogout();
    renderWithAuth(
      <AppShell currentRoute="/agent" onNavigate={() => undefined}>测试内容</AppShell>,
      { meValue: demoMe },
    );
    await screen.findByText('演示老师');

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(logoutMock).toHaveBeenCalledTimes(1);
  });
});
