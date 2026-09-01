import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listTeachers, type AdminTeacherListItem, type AdminTeacherStatus } from '../api/adminTeachers';
import { createTeacher } from '../api/adminActions';
import { formatDateTime } from '../shared/date-format';
import '../styles/admin.css';

const PAGE_SIZE = 20;

interface TeachersPageProps {
  onSelectTeacher: (teacherId: string) => void;
}

/**
 * 教师总览（/admin/teachers）：分页列表 + status 过滤 + 新建教师（A5 动作，可选 provision 建库）。
 * 列表页不做跨库聚合（性能红线，设计 §2.1）；聚合在详情页按需懒加载。
 */
export function TeachersPage({ onSelectTeacher }: TeachersPageProps) {
  const [items, setItems] = useState<AdminTeacherListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<AdminTeacherStatus | ''>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ email: '', password: '', displayName: '', databaseName: '', provision: false });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listTeachers({
      status: status === '' ? undefined : status,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const canCreate = createForm.email.trim().length > 0
    && createForm.password.length > 0
    && createForm.displayName.trim().length > 0
    && !creating;

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;

    setCreating(true);
    setCreateMessage(null);
    try {
      const created = await createTeacher({
        email: createForm.email.trim(),
        password: createForm.password,
        displayName: createForm.displayName.trim(),
        databaseName: createForm.databaseName.trim() || undefined,
      }, createForm.provision);
      setCreateMessage(`已创建 ${created.displayName}（${created.databaseName}），已记录审计`);
      setCreateForm({ email: '', password: '', displayName: '', databaseName: '', provision: false });
      setShowCreate(false);
      load();
    } catch (createError) {
      setCreateMessage(`创建失败：${messageOf(createError)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="admin-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 教师</p>
        <h2>教师总览</h2>
        <p>查看已注册教师的账号与数据库归属；点击教师进入详情（学生/课程/反馈/Agent 聚合）。</p>
      </header>

      <div className="page-card admin-teachers-card">
        <div className="admin-list-toolbar">
          <label>
            状态过滤
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as AdminTeacherStatus | '');
                setPage(1);
              }}
            >
              <option value="">全部</option>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
          </label>
          <span className="admin-list-total">共 {total} 位教师</span>
          <button type="button" className="secondary-action" onClick={() => setShowCreate((current) => !current)}>
            {showCreate ? '收起新建' : '新建教师'}
          </button>
        </div>

        {showCreate ? (
          <form className="admin-create-form" onSubmit={handleCreate}>
            <h4>新建教师</h4>
            <label htmlFor="create-email">
              邮箱
              <input id="create-email" type="email" value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} required />
            </label>
            <label htmlFor="create-password">
              密码
              <input id="create-password" type="password" autoComplete="new-password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} required />
            </label>
            <label htmlFor="create-display-name">
              昵称
              <input id="create-display-name" value={createForm.displayName} onChange={(event) => setCreateForm({ ...createForm, displayName: event.target.value })} required />
            </label>
            <label htmlFor="create-database-name">
              数据库名（可选，缺省自动生成）
              <input id="create-database-name" value={createForm.databaseName} onChange={(event) => setCreateForm({ ...createForm, databaseName: event.target.value })} />
            </label>
            <label className="admin-create-provision">
              <input type="checkbox" checked={createForm.provision} onChange={(event) => setCreateForm({ ...createForm, provision: event.target.checked })} />
              同时建库（provision=1，后台任务）
            </label>
            <button type="submit" className="primary-action" disabled={!canCreate}>
              {creating ? '创建中…' : '创建教师'}
            </button>
          </form>
        ) : null}
        {createMessage ? <p className="admin-action-toast" role="status">{createMessage}</p> : null}

        {loading ? <p className="muted">正在加载教师列表</p> : null}
        {!loading && error ? <p className="admin-error" role="alert">列表加载失败：{error}</p> : null}
        {!loading && !error && items.length === 0 ? <p className="muted">暂无教师记录。</p> : null}

        {!loading && !error && items.length > 0 ? (
          <ul className="admin-teacher-list">
            {items.map((teacher) => (
              <li key={teacher.id}>
                <button
                  type="button"
                  className="admin-teacher-row"
                  onClick={() => onSelectTeacher(teacher.id)}
                >
                  <span className="admin-teacher-main">
                    <strong>{teacher.displayName}</strong>
                    <small>{teacher.email}</small>
                  </span>
                  <span className={`status-badge admin-status--${teacher.status}`}>
                    {teacher.status === 'active' ? '启用' : '停用'}
                  </span>
                  <span className="admin-teacher-db">{teacher.databaseName}</span>
                  <time className="admin-teacher-time" dateTime={teacher.createdAtTs}>
                    {formatDateTime(teacher.createdAtTs)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {!loading && !error && total > 0 ? (
          <div className="admin-pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              上一页
            </button>
            <span>第 {page} / {pageCount} 页</span>
            <button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>
              下一页
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
