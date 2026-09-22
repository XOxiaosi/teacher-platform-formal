import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcceptInvitationPage } from './AcceptInvitationPage';
import * as authApi from '../api/auth';

vi.mock('../api/auth');

const cleanUrl = () => window.history.replaceState(null, '', '/accept-invitation');

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, '', '/accept-invitation#token=synthetic-invitation-token');
});

afterEach(() => cleanUrl());

describe('AcceptInvitationPage', () => {
  it('从 fragment 读取合成邀请 token 后立即清除 URL，并且不把 token 展示出来', async () => {
    render(<AcceptInvitationPage onAccepted={vi.fn(async () => undefined)} />);

    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.getByRole('heading', { name: '创建你的工作空间' })).toBeInTheDocument();
    expect(screen.queryByText('synthetic-invitation-token')).not.toBeInTheDocument();
  });

  it('StrictMode 重放 effect 后仍保留首次读取的 token 并可提交', async () => {
    const onAccepted = vi.fn(async () => undefined);
    vi.mocked(authApi.acceptInvitation).mockResolvedValue(undefined);
    render(<StrictMode><AcceptInvitationPage onAccepted={onAccepted} /></StrictMode>);
    await waitFor(() => expect(window.location.hash).toBe(''));
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '张老师' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请并进入工作台' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(authApi.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ token: 'synthetic-invitation-token' }));
  });

  it('密码不一致时显示明确错误且不调用接受邀请接口', async () => {
    render(<AcceptInvitationPage onAccepted={vi.fn(async () => undefined)} />);
    await screen.findByRole('heading', { name: '创建你的工作空间' });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '张老师' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password456' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请并进入工作台' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(authApi.acceptInvitation).not.toHaveBeenCalled();
  });

  it('接受成功后提交显示名和密码，并刷新进入工作台', async () => {
    const onAccepted = vi.fn(async () => undefined);
    vi.mocked(authApi.acceptInvitation).mockResolvedValue(undefined);
    render(<AcceptInvitationPage onAccepted={onAccepted} />);
    await screen.findByRole('heading', { name: '创建你的工作空间' });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: ' 张老师 ' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请并进入工作台' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(authApi.acceptInvitation).toHaveBeenCalledWith({ token: 'synthetic-invitation-token', displayName: '张老师', password: 'password123' });
  });

  it('没有 token 时显示邀请链接无效状态并禁用提交', async () => {
    window.history.replaceState(null, '', '/accept-invitation');
    render(<AcceptInvitationPage onAccepted={vi.fn(async () => undefined)} />);

    expect(await screen.findByRole('heading', { name: '创建你的工作空间' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接受邀请并进入工作台' })).toBeDisabled();
    expect(screen.getByText('邀请链接无效或已失效，请让管理员重新发送邀请。')).toBeInTheDocument();
  });

  it('后端拒绝邀请时保留表单并显示可处理的错误', async () => {
    vi.mocked(authApi.acceptInvitation).mockRejectedValue(new Error('邀请无效、已失效或已被使用'));
    render(<AcceptInvitationPage onAccepted={vi.fn(async () => undefined)} />);
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '张老师' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '接受邀请并进入工作台' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('邀请无效、已失效或已被使用');
    expect(screen.getByLabelText('显示名称')).toHaveValue('张老师');
    expect(screen.queryByText('synthetic-invitation-token')).not.toBeInTheDocument();
  });
});
