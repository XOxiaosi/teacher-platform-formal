import { useCallback, useEffect, useState } from 'react';
import { getHealth, getInteractions, type AdminHealthData, type AdminInteractionsStats } from '../api/adminActions';
import { formatDateTime } from '../shared/date-format';
import '../styles/admin.css';

/**
 * 交互/健康看板（/admin/health，A4）：
 * - 交互统计（设计 §2.2）：AgentExecution status 分布 / 平均与最大耗时 / 错误率 / 最近交互
 * - 系统健康（设计 §2.3）：ready / 教师库巡检汇总 / 备份状态 / 迁移版本 / metrics 摘要
 */
export function HealthPage() {
  const [interactions, setInteractions] = useState<AdminInteractionsStats | null>(null);
  const [health, setHealth] = useState<AdminHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getInteractions(), getHealth()])
      .then(([interactionStats, healthData]) => {
        setInteractions(interactionStats);
        setHealth(healthData);
      })
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="admin-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 系统</p>
        <h2>交互与健康看板</h2>
        <p>Agent 交互统计与系统健康概览（数据库巡检/备份/迁移/请求指标）。</p>
      </header>

      {loading ? <p className="muted">正在加载看板数据</p> : null}
      {!loading && error ? <p className="admin-error" role="alert">看板加载失败：{error}</p> : null}

      {!loading && !error ? (
        <>
          <article className="page-card admin-health-section" aria-label="交互统计">
            <h3>Agent 交互统计</h3>
            {interactions === null ? (
              <p className="muted">暂无交互统计数据。</p>
            ) : (
              <>
                <div className="admin-health-grid">
                  <HealthMetric label="执行总数" value={interactions.total} />
                  <HealthMetric label="平均耗时" value={interactions.avgDurationMs === null ? '—' : `${Math.round(interactions.avgDurationMs)}ms`} />
                  <HealthMetric label="最大耗时" value={interactions.maxDurationMs === null ? '—' : `${Math.round(interactions.maxDurationMs)}ms`} />
                  <HealthMetric label="错误率" value={`${(interactions.errorRate * 100).toFixed(1)}%`} />
                </div>
                <div className="admin-status-distribution">
                  <h4>状态分布</h4>
                  <ul>
                    {Object.entries(interactions.byStatus).map(([statusKey, count]) => (
                      <li key={statusKey}>
                        <span className={`admin-exec-status admin-exec-status--${statusKey}`}>{statusKey}</span>
                        <strong>{count}</strong>
                      </li>
                    ))}
                  </ul>
                  {Object.keys(interactions.byStatus).length === 0 ? <p className="muted">无执行记录。</p> : null}
                </div>
                <p className="admin-health-last">
                  最近交互：{interactions.lastInteractionAtTs ? formatDateTime(interactions.lastInteractionAtTs) : '暂无'}
                </p>
              </>
            )}
          </article>

          <article className="page-card admin-health-section" aria-label="系统健康">
            <h3>系统健康</h3>
            {health === null ? (
              <p className="muted">暂无健康数据。</p>
            ) : (
              <>
                <p className={`admin-ready ${health.ready ? 'admin-ready--ok' : 'admin-ready--bad'}`} role="status">
                  {health.ready ? '共享库可达（ready）' : `共享库不可达：${health.message ?? '未知原因'}`}
                </p>
                <div className="admin-health-grid">
                  <HealthMetric label="巡检正常" value={health.dbHealth.ok} />
                  <HealthMetric label="库缺失" value={health.dbHealth.missing} />
                  <HealthMetric label="迁移落后" value={health.dbHealth.migrationBehind} />
                  <HealthMetric label="不可达" value={health.dbHealth.unreachable} />
                </div>
                <dl className="admin-detail-dl">
                  <div><dt>备份</dt><dd>{health.backup.lastRunId ? `最近 ${formatDateTime(health.backup.lastRunAtTs ?? '')} · ${health.backup.databases} 库 · ${health.backup.success ? '成功' : '失败'}` : '暂无备份记录'}</dd></div>
                  <div><dt>迁移版本</dt><dd>{health.migration.applied} / {health.migration.expected}</dd></div>
                  <div><dt>请求指标</dt><dd>5xx {health.metrics.requests5xx} · p95 {health.metrics.p95DurationMs === null ? '—' : `${Math.round(health.metrics.p95DurationMs)}ms`}</dd></div>
                </dl>
              </>
            )}
          </article>
        </>
      ) : null}
    </section>
  );
}

function HealthMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="admin-health-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
