import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as teachersApi from '../api/adminTeachers';
import * as actionsApi from '../api/adminActions';
import { buildTeacherInvitationUrl, TeachersPage } from './TeachersPage';

vi.mock('../api/adminTeachers');
vi.mock('../api/adminActions');

const teachers = [{ id: 't1', email: 'a@b.com', displayName: '张三', status: 'active' as const, databaseName: 'db', createdAtTs: '2026-08-01T00:00:00Z', updatedAtTs: '2026-08-01T00:00:00Z' }];
const invitation = { id: 'i1', email: 'new@b.com', status: 'pending' as const, createdAtTs: '2026-08-01T00:00:00Z', expiresAtTs: '2026-08-04T00:00:00Z' };

beforeEach(() => {
  vi.mocked(teachersApi.listTeachers).mockResolvedValue({ items: teachers, total: 1 });
  vi.mocked(actionsApi.listInvitations).mockResolvedValue({ items: [invitation] });
  vi.mocked(actionsApi.createInvitation).mockResolvedValue({ invitation, token: 'raw-token' });
  vi.mocked(actionsApi.revokeInvitation).mockResolvedValue({ invitation: { ...invitation, status: 'revoked' } });
  window.history.replaceState(null, '', '/');
});

describe('TeachersPage invitation management', () => {
  it('生产地址可显式指向教师端，token 只放在 fragment', () => {
    expect(buildTeacherInvitationUrl('raw token/+', 'https://teacher.example.com/')).toBe(
      'https://teacher.example.com/accept-invitation#token=raw%20token%2F%2B',
    );
  });

  it('展示教师和邀请状态，不显示 token', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(screen.getByText('new@b.com')).toBeInTheDocument();
    expect(screen.getByText('待接受')).toBeInTheDocument();
    expect(screen.queryByText('raw-token')).not.toBeInTheDocument();
  });

  it('创建邀请默认72小时并一次性构造接受链接', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
    await waitFor(() => expect(actionsApi.createInvitation).toHaveBeenCalledWith({ email: 'new@b.com', expiresInHours: 72 }));
    expect(screen.getByLabelText('一次性邀请链接')).toHaveValue('http://localhost:5173/accept-invitation#token=raw-token');
  });

  it('pending 邀请可撤销', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    await screen.findByText('new@b.com');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(actionsApi.revokeInvitation).toHaveBeenCalledWith('i1'));
  });

  it('有效期超过168小时不能提交', async () => {
    render(<TeachersPage onSelectTeacher={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'x@y.com' } });
    fireEvent.change(screen.getByLabelText(/有效期/), { target: { value: '169' } });
    expect(screen.getByRole('button', { name: '创建邀请' })).toBeDisabled();
  });
});
