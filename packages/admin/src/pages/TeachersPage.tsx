import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listTeachers, type AdminTeacherListItem, type AdminTeacherStatus } from '../api/adminTeachers';
import { createInvitation, listInvitations, revokeInvitation, type AdminInvitation } from '../api/adminActions';
import { formatDateTime } from '../shared/date-format';
import '../styles/admin.css';

const PAGE_SIZE = 20;
const DEFAULT_EXPIRY_HOURS = 72;
const MAX_EXPIRY_HOURS = 168;

interface TeachersPageProps { onSelectTeacher: (teacherId: string) => void; }

export function TeachersPage({ onSelectTeacher }: TeachersPageProps) {
  const [items, setItems] = useState<AdminTeacherListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<AdminTeacherStatus | ''>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [expiry, setExpiry] = useState(String(DEFAULT_EXPIRY_HOURS));
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);

  const loadTeachers = useCallback(() => {
    setLoading(true);
    setError(null);
    listTeachers({ status: status || undefined, page, pageSize: PAGE_SIZE })
      .then((result) => { setItems(result.items); setTotal(result.total); })
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, [page, status]);
  const loadInvitations = useCallback(() => {
    listInvitations()
      .then((result) => setInvitations(result.items))
      .catch((loadError: unknown) => setMessage('邀请列表加载失败：' + messageOf(loadError)));
  }, []);
  useEffect(() => loadTeachers(), [loadTeachers]);
  useEffect(() => loadInvitations(), [loadInvitations]);

  const expiryHours = Number(expiry);
  const canCreate = email.trim().length > 0 && Number.isInteger(expiryHours)
    && expiryHours >= 1 && expiryHours <= MAX_EXPIRY_HOURS && !creating;

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setCreating(true); setMessage(null); setOneTimeLink(null);
    try {
      const result = await createInvitation({ email: email.trim(), expiresInHours: expiryHours });
      const acceptUrl = buildTeacherInvitationUrl(result.token);
      setOneTimeLink(acceptUrl);
      setMessage('邀请已创建。请立即复制邀请链接；关闭后不会再次显示。');
      setEmail(''); setExpiry(String(DEFAULT_EXPIRY_HOURS)); loadInvitations();
    } catch (createError) {
      setMessage('创建邀请失败：' + messageOf(createError));
    } finally { setCreating(false); }
  }
  async function handleRevoke(invitationId: string) {
    try { await revokeInvitation(invitationId); loadInvitations(); }
    catch (revokeError) { setMessage('撤销失败：' + messageOf(revokeError)); }
  }

  return (
    <section className="admin-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 教师</p><h2>教师与邀请</h2>
        <p>教师通过一次性邀请链接完成注册；管理员不接触教师密码。</p>
      </header>
      <div className="page-card admin-teachers-card">
        <div className="admin-list-toolbar">
          <label>状态过滤
            <select value={status} onChange={(event) => { setStatus(event.target.value as AdminTeacherStatus | ''); setPage(1); }}>
              <option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option>
            </select>
          </label>
          <span className="admin-list-total">共 {total} 位教师</span>
          <button type="button" className="secondary-action" onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? '收起创建邀请' : '创建邀请'}
          </button>
        </div>
        {showCreate ? (
          <form className="admin-create-form" onSubmit={handleCreate}>
            <h4>创建教师邀请</h4>
            <label htmlFor="create-email">邮箱
              <input id="create-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label htmlFor="invite-expiry">有效期（小时，1–168）
              <input id="invite-expiry" type="number" min="1" max={MAX_EXPIRY_HOURS} value={expiry} onChange={(event) => setExpiry(event.target.value)} required />
            </label>
            <button type="submit" className="primary-action" disabled={!canCreate}>{creating ? '创建中…' : '创建邀请'}</button>
          </form>
        ) : null}
        {oneTimeLink ? (
          <div className="admin-action-toast" role="status">
            <p>{message}</p>
            <label htmlFor="one-time-invitation-link">一次性邀请链接
              <input id="one-time-invitation-link" readOnly value={oneTimeLink} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <button type="button" className="secondary-action" onClick={() => void navigator.clipboard?.writeText(oneTimeLink)}>复制链接</button>
            <small>Token 仅本次显示，后台不会保存明文。</small>
          </div>
        ) : null}
        {!oneTimeLink && message ? <p className="admin-action-toast" role="status">{message}</p> : null}
        <h3>待处理邀请</h3>
        {invitations.length === 0 ? <p className="muted">暂无邀请记录。</p> : (
          <ul className="admin-teacher-list">{invitations.map((invitation) => (
            <li key={invitation.id} className="admin-teacher-row">
              <span><strong>{invitation.email}</strong><small>{invitationLabel(invitation.status)}</small></span>
              <time dateTime={invitation.expiresAtTs}>到期 {formatDateTime(invitation.expiresAtTs)}</time>
              {invitation.status === 'pending' ? <button type="button" className="secondary-action" onClick={() => void handleRevoke(invitation.id)}>撤销</button> : null}
            </li>
          ))}</ul>
        )}
        <h3>教师列表</h3>
        {loading ? <p className="muted">正在加载教师列表</p> : null}
        {!loading && error ? <p className="admin-error" role="alert">列表加载失败：{error}</p> : null}
        {!loading && !error && items.length === 0 ? <p className="muted">暂无教师记录。</p> : null}
        {!loading && !error && items.length > 0 ? (
          <ul className="admin-teacher-list">{items.map((teacher) => (
            <li key={teacher.id}><button type="button" className="admin-teacher-row" onClick={() => onSelectTeacher(teacher.id)}>
              <span className="admin-teacher-main"><strong>{teacher.displayName}</strong><small>{teacher.email}</small></span>
              <span className={'status-badge admin-status--' + teacher.status}>{teacher.status === 'active' ? '启用' : '停用'}</span>
              <time dateTime={teacher.createdAtTs}>{formatDateTime(teacher.createdAtTs)}</time>
            </button></li>
          ))}</ul>
        ) : null}
        {!loading && total > 0 ? <div className="admin-pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <span>第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
          <button type="button" disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((value) => value + 1)}>下一页</button>
        </div> : null}
      </div>
    </section>
  );
}
function invitationLabel(status: AdminInvitation['status']): string {
  return status === 'pending' ? '待接受' : status === 'consumed' ? '已接受' : status === 'revoked' ? '已撤销' : '已过期';
}
export function buildTeacherInvitationUrl(token: string, configuredBase = import.meta.env.VITE_TEACHER_APP_URL): string {
  const configured = configuredBase?.trim().replace(/\/$/, '');
  const base = configured || (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:5173`
    : window.location.origin);
  return `${base}/accept-invitation#token=${encodeURIComponent(token)}`;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
