import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getTeacherDetail, type AdminRecentExecution, type AdminTeacherDetail } from '../api/adminTeachers';
import {
  pollBackupStatus,
  triggerBackup,
  triggerRestore,
  updateTeacherStatus,
  type BackupJobStatus,
} from '../api/adminActions';
import { formatDateTime } from '../shared/date-format';
import '../styles/admin.css';

interface TeacherDetailPageProps {
  teacherId: string;
  onBack: () => void;
  /** 备份轮询间隔（测试注入用，默认 2000ms） */
  pollDelayMs?: number;
}

const RESTORE_TARGET_HINT = '仅演练目标（teacher_db_*_restore_*），禁覆盖生产库';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 15;

/**
 * 教师详情（/admin/teachers/:id）：懒加载单库聚合 + 管理动作 UI（A5）。
 * - 禁用/启用：PATCH status（window.confirm 二次确认）
 * - 手动备份：POST /admin/backup → jobId 轮询 GET /admin/backup/status（进度/结果）
 * - 恢复演练：POST /admin/restore?confirm=1（仅 *_restore_* 目标，二次确认）
 * - 动作成功 toast「已记录审计」；失败展示错误信封 message
 */
export function TeacherDetailPage({ teacherId, onBack, pollDelayMs = POLL_INTERVAL_MS }: TeacherDetailPageProps) {
  const [detail, setDetail] = useState<AdminTeacherDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null); // toast / 错误
  const [backupStatus, setBackupStatus] = useState<BackupJobStatus | null>(null);
  const [restoreTarget, setRestoreTarget] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTeacherDetail(teacherId)
      .then(setDetail)
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, [teacherId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleStatus() {
    if (!detail) return;
    const next = detail.teacher.status === 'active' ? 'disabled' : 'active';
    const label = next === 'disabled' ? '禁用' : '启用';
    if (!window.confirm(`确定${label}账号 ${detail.teacher.displayName}？此操作会写入审计日志。`)) return;

    setActionBusy(true);
    setActionMessage(null);
    try {
      await updateTeacherStatus(teacherId, next);
      setActionMessage(`${label}成功，已记录审计`);
      load();
    } catch (toggleError) {
      setActionMessage(`操作失败：${messageOf(toggleError)}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleBackup() {
    if (!detail) return;
    setActionBusy(true);
    setActionMessage(null);
    setBackupStatus({ status: 'running' });
    try {
      const { jobId } = await triggerBackup(teacherId);
      let current: BackupJobStatus = { status: 'running' };
      for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt += 1) {
        await delay(pollDelayMs);
        current = await pollBackupStatus(jobId);
        setBackupStatus(current);
        if (current.status !== 'running') break;
      }
      if (current.status === 'running') {
        setBackupStatus({ status: 'running', detail: '轮询超时，请稍后查看' });
        setActionMessage('备份仍在执行（轮询超时），已记录审计');
      } else if (current.status === 'succeeded') {
        setActionMessage('备份完成，已记录审计');
      } else {
        setActionMessage(`备份失败：${current.detail ?? '未知错误'}（已记录审计）`);
      }
    } catch (backupError) {
      setActionMessage(`备份失败：${messageOf(backupError)}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRestore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = restoreTarget.trim();
    if (!target) return;
    if (!window.confirm(`确认对演练目标 ${target} 执行恢复？仅允许 *_restore_* 目标，且会写入审计日志。`)) return;

    setActionBusy(true);
    setActionMessage(null);
    try {
      await triggerRestore({ targetDatabaseName: target });
      setActionMessage('恢复演练已提交，已记录审计');
      setRestoreTarget('');
    } catch (restoreError) {
      setActionMessage(`恢复失败：${messageOf(restoreError)}`);
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) {
    return <section className="page-card admin-page">正在加载教师详情</section>;
  }

  if (error || !detail) {
    return (
      <section className="page-card admin-page" role="alert">
        <p className="eyebrow">Error</p>
        <h2>教师详情加载失败</h2>
        <p>{error ?? '无数据'}</p>
        <button type="button" className="secondary-action" onClick={onBack}>返回教师总览</button>
      </section>
    );
  }

  const { teacher, aggregates, degraded, degradedReason } = detail;
  const isActive = teacher.status === 'active';

  return (
    <section className="admin-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 教师详情</p>
        <h2>{teacher.displayName}</h2>
        <p>{teacher.email} · {teacher.databaseName}</p>
      </header>

      <div className="admin-detail-actions">
        <button type="button" className="secondary-action" onClick={onBack}>返回教师总览</button>
        {isActive ? (
          <button type="button" disabled={actionBusy} onClick={() => void handleToggleStatus()}>禁用账号</button>
        ) : (
          <button type="button" disabled={actionBusy} onClick={() => void handleToggleStatus()}>启用账号</button>
        )}
        <button type="button" disabled={actionBusy} onClick={() => void handleBackup()}>
          {backupStatus?.status === 'running' ? '备份中…' : '手动备份'}
        </button>
      </div>

      {actionMessage ? <p className="admin-action-toast" role="status">{actionMessage}</p> : null}
      {backupStatus?.status === 'running' ? (
        <p className="admin-action-progress" role="status">备份任务执行中，请稍候…</p>
      ) : null}
      {backupStatus && backupStatus.status !== 'running' ? (
        <p className="admin-action-progress" role="status">备份结果：{backupStatus.status === 'succeeded' ? '成功' : '失败'} {backupStatus.detail ?? ''}</p>
      ) : null}

      <article className="page-card admin-teacher-meta">
        <h3>账号信息</h3>
        <dl className="admin-detail-dl">
          <div><dt>状态</dt><dd><span className={`status-badge admin-status--${teacher.status}`}>{isActive ? '启用' : '停用'}</span></dd></div>
          <div><dt>邮箱</dt><dd>{teacher.email}</dd></div>
          <div><dt>数据库</dt><dd>{teacher.databaseName}</dd></div>
          <div><dt>注册时间</dt><dd>{formatDateTime(teacher.createdAtTs)}</dd></div>
          <div><dt>最后更新</dt><dd>{formatDateTime(teacher.updatedAtTs)}</dd></div>
        </dl>
      </article>

      <article className="page-card admin-restore-card">
        <h3>恢复演练</h3>
        <p className="admin-restore-hint">{RESTORE_TARGET_HINT}</p>
        <form className="admin-restore-form" onSubmit={handleRestore}>
          <label htmlFor="admin-restore-target">
            演练目标数据库名
            <input
              id="admin-restore-target"
              value={restoreTarget}
              onChange={(event) => setRestoreTarget(event.target.value)}
              placeholder="teacher_db_demo_restore_20260831"
              required
            />
          </label>
          <button type="submit" className="primary-action" disabled={actionBusy || restoreTarget.trim() === ''}>
            执行恢复演练
          </button>
        </form>
      </article>

      <article className="page-card admin-aggregates" aria-label="教师数据聚合">
        <h3>数据聚合</h3>
        {degraded ? (
          <p className="admin-degraded" role="status">⚠ 聚合超时（degraded）：{degradedReason ?? '单库聚合超过 5s，部分指标缺失'}</p>
        ) : null}
        {aggregates === null ? (
          <p className="muted">聚合数据不可用。</p>
        ) : (
          <>
            <div className="admin-aggregate-grid">
              <Metric label="学生" value={aggregates.studentCount} />
              <Metric label="日程" value={aggregates.scheduleCount} />
              <Metric label="课程" value={aggregates.lessonCount} />
              <Metric label="缴费" value={aggregates.paymentCount} />
              <Metric label="家长反馈" value={aggregates.feedbackCount} />
              <Metric label="Agent 执行" value={aggregates.agentExecutionCount} />
            </div>
            <p className="admin-aggregate-last">
              最近交互：{aggregates.lastInteractionAtTs ? formatDateTime(aggregates.lastInteractionAtTs) : '暂无'}
            </p>
            <RecentExecutionsList recent={aggregates.recentExecutions} />
          </>
        )}
      </article>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-aggregate-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RecentExecutionsList({ recent }: { recent: AdminRecentExecution[] }) {
  if (recent.length === 0) return <p className="muted">暂无 Agent 交互记录。</p>;
  return (
    <div className="admin-recent-executions">
      <h4>最近交互</h4>
      <ul>
        {recent.map((execution) => (
          <li key={execution.id}>
            <span className={`admin-exec-status admin-exec-status--${execution.status}`}>{execution.status}</span>
            <span>{execution.summary ?? '（无摘要）'}</span>
            <time dateTime={execution.startedAtTs ?? undefined}>
              {execution.startedAtTs ? formatDateTime(execution.startedAtTs) : '—'}
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
