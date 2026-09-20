import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, Shell } from './Chrome';

describe('测试版多步弹窗焦点', () => {
  it('替换步骤后聚焦新弹窗，Tab 循环且 Escape 仍可关闭', () => {
    const close = vi.fn();
    const { rerender } = render(<Dialog title="课程详情" onClose={close}><button>编辑课程</button></Dialog>);
    screen.getByRole('button', { name: '编辑课程' }).focus();
    rerender(<Dialog title="修改课程" onClose={close}><input aria-label="地点" /><button>查看确认</button></Dialog>);
    const closeButton = screen.getByRole('button', { name: '关闭' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: '查看确认' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: '查看确认' }), { key: 'Tab' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});

it('保存期间保持弹窗锁定，结束后才允许关闭', () => {
  const close = vi.fn();
  const { rerender } = render(<Dialog title="保存学生" onClose={close} disabled><input aria-label="姓名" /></Dialog>);
  expect(screen.getByRole('dialog')).toHaveAttribute('inert');
  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  rerender(<Dialog title="保存学生" onClose={close}><input aria-label="姓名" /></Dialog>);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
});

it('账号菜单支持键盘打开、方向键选择与执行后收起', async () => {
  const refresh = vi.fn();
  render(<Shell page="students" studioName="测试工作室" accountActions={<><a href="#/captures">待核对材料</a><span>teacher@example.test</span><button onClick={refresh}>刷新资料</button></>}><p>学生列表</p></Shell>);
  fireEvent.keyDown(screen.getByRole('button', { name: '账号菜单' }), { key: 'Enter' });
  const first = await screen.findByRole('menuitem', { name: '待核对材料' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '刷新资料' })).toHaveFocus());
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '刷新资料' }), { key: 'Enter' });
  expect(refresh).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
});
