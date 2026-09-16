import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedWorkspace } from './ConnectedWorkspace';
import { createDemoData } from '../preview/data';

const mock = vi.hoisted(() => ({ load: vi.fn(), command: vi.fn(), schedule: vi.fn(), payment: vi.fn(), update: vi.fn(), logout: vi.fn() }));
vi.mock('../app/teacher-context', () => ({ useAuth: () => ({ teacherId: 'teacher-a', displayName: '验收老师', email: 'a@example.test', logout: mock.logout }) }));
vi.mock('./workspace-api', () => ({ loadWorkspace: mock.load, workspaceCommand: mock.command, schedulingCommand: mock.schedule }));
vi.mock('../api/payments', () => ({ createPayment: mock.payment }));
vi.mock('../api/students', () => ({ updateStudentProfile: mock.update }));
vi.mock('./ModelConfiguration', () => ({ ModelConfiguration: ({ teacherId }: { teacherId: string }) => <div>具体模型配置：{teacherId}</div> }));
vi.mock('../connected/assistant', () => ({ AssistantWorkspace: ({ teacherId }: { teacherId: string }) => <section aria-label="正式教学助手入口"><h1>教学助手</h1><p>当前账号：{teacherId}</p></section> }));

const snapshot = () => ({ data: createDemoData(), studentVersions: { s1: 'v1', s2: 'v2' }, feedbackVersions: {}, memoVersions: { m1: 'm1-v1' }, preferenceVersion: null });
beforeEach(() => { vi.clearAllMocks(); location.hash = '#/students'; mock.load.mockResolvedValue(snapshot()); mock.command.mockResolvedValue({}); mock.schedule.mockResolvedValue({}); });

describe('connected workspace server-backed writes', () => {
  it('connects settings to actual model configuration rather than response preferences', async () => {
    location.hash = '#/settings/models';
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '模型与 API', level: 1 });
    expect(screen.getByText('具体模型配置：teacher-a')).toBeInTheDocument();
    expect(screen.queryByText('助手响应偏好')).not.toBeInTheDocument();
  });
  it('mounts the formal assistant entry for the authenticated teacher', async () => {
    location.hash = '#/agent';
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '教学助手' });
    expect(screen.getByRole('region', { name: '正式教学助手入口' })).toHaveTextContent('当前账号：teacher-a');
  });
  it('waits for the server before closing a student form and reloads canonical data', async () => {
    let resolveWrite!: () => void;
    mock.command.mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    render(<ConnectedWorkspace />);
    await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '服务器学生' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('学生已添加')).not.toBeInTheDocument();
    expect(screen.getByText('正在处理，请稍候…')).toBeInTheDocument();
    expect(mock.command).toHaveBeenCalledWith('students', expect.objectContaining({ name: '服务器学生', grade: '初一', clientRequestId: expect.any(String) }));
    const next = snapshot(); next.data.students.push({ id: 'server-id', name: '服务器学生', grade: '初一', balance: 0, notes: [] }); mock.load.mockResolvedValue(next);
    await act(async () => resolveWrite());
    await screen.findByText('学生已添加');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('服务器学生')).toBeInTheDocument();
  });
  it('keeps input on failure and reuses the request key when the same operation is retried', async () => {
    mock.command.mockRejectedValue(new Error('网络暂时不可用'));
    render(<ConnectedWorkspace />); await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '保留输入' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初三' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('网络暂时不可用');
    expect(screen.getByLabelText('姓名')).toHaveValue('保留输入');
    expect(screen.queryByText('学生已添加')).not.toBeInTheDocument();
    const key = mock.command.mock.calls[0][1].clientRequestId;
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await waitFor(() => expect(mock.command).toHaveBeenCalledTimes(2));
    expect(mock.command.mock.calls[1][1].clientRequestId).toBe(key);
  });
  it('does not show synthetic fallback data when the backend is unavailable', async () => {
    mock.load.mockRejectedValue(new Error('后端不可达'));
    render(<ConnectedWorkspace />);
    await screen.findByRole('alert');
    expect(screen.queryByText('王浩然')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
  it('does not use local setData to toggle a saved memo', async () => {
    location.hash = '#/today'; render(<ConnectedWorkspace />);
    const checkbox = await screen.findByRole('checkbox', { name: '确认本周空闲时段' });
    fireEvent.click(checkbox);
    await waitFor(() => expect(mock.command).toHaveBeenCalledWith('memo-status', expect.objectContaining({ id: 'm1', done: true, expectedUpdatedAt: 'm1-v1' })));
  });
  it('blocks further writes when a successful save cannot reload its canonical result', async () => {
    render(<ConnectedWorkspace />); await screen.findByRole('heading', { name: '我的学生' });
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '已写入数据库' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    mock.load.mockRejectedValue(new Error('刷新失败'));
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('操作已保存，但最新资料加载失败。请刷新资料核对，不要重复登记。');
    fireEvent.click(screen.getByRole('button', { name: '+ 新增学生' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '第二次修改' } });
    fireEvent.change(screen.getByLabelText('年级', { selector: 'input' }), { target: { value: '初一' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学生' }));
    await screen.findByText('请先点击“刷新资料”核对已保存的操作，再继续修改。');
    expect(mock.command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    mock.load.mockResolvedValue(snapshot());
    fireEvent.click(screen.getByRole('button', { name: '刷新资料' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
