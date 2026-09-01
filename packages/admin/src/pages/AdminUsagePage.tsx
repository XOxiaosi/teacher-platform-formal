import { useCallback, useEffect, useState } from 'react';
import { getAdminUsageSummary, type AdminUsageSummary, type AdminUsageSummaryRow } from '../api/adminUsage';
import '../styles/admin.css';
import '../styles/admin-usage.css';

const RANGES = [
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: '90d', label: '近 90 天', days: 90 },
] as const;

type UsageRangeKey = (typeof RANGES)[number]['key'];

/**
 * 平台级用量费用看板（/admin/usage，backend5 t28）。
 * - totals 卡片：prompt/completion/total tokens + 请求数（ProviderUsage 共享库跨教师聚合）
 * - byProvider 明细：providerName|model 分组，totalTokens 降序
 * - 时段切换 7d/30d/90d（前端重算 from/to 调 GET /admin/usage/summary）
 * - teacherId 钻取：输入教师 id（空 = 全平台），应用后作为过滤参数
 */
export function AdminUsagePage() {
  const [range, setRange] = useState<UsageRangeKey>('30d');
  const [teacherInput, setTeacherInput] = useState('');
  const [teacherId, setTeacherId] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<AdminUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const to = new Date();
    const days = RANGES.find((spec) => spec.key === range)?.days ?? 30;
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    getAdminUsageSummary({
      from: from.toISOString(),
      to: to.toISOString(),
      teacherId,
    })
      .then(setSummary)
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, [range, teacherId]);

  useEffect(() => {
    load();
  }, [load]);

  function applyTeacherDrillDown() {
    setTeacherId(teacherInput.trim() === '' ? undefined : teacherInput.trim());
  }

  function clearTeacherFilter() {
    setTeacherInput('');
    setTeacherId(undefined);
  }

  const rangeLabel = RANGES.find((spec) => spec.key === range)?.label ?? '近 30 天';

  return (
    <section className="admin-page admin-usage-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 用量</p>
        <h2>用量费用看板</h2>
        <p>平台级 LLM 用量总览（ProviderUsage 共享库跨教师聚合）：按时间段与单教师钻取，查看 token 消耗与请求量。</p>
      </header>

      <div className="page-card admin-usage-card">
        <div className="admin-list-toolbar admin-usage-toolbar">
          <div className="admin-usage-controls">
            <div className="admin-usage-ranges" role="group" aria-label="时间段切换">
              {RANGES.map((spec) => (
                <button
                  key={spec.key}
                  type="button"
                  className={range === spec.key ? 'active' : ''}
                  aria-pressed={range === spec.key}
                  onClick={() => setRange(spec.key)}
                >
                  {spec.label}
                </button>
              ))}
            </div>
            <div className="admin-usage-teacher-filter">
              <label htmlFor="admin-usage-teacher-input">教师钻取</label>
              <input
                id="admin-usage-teacher-input"
                type="text"
                value={teacherInput}
                onChange={(event) => setTeacherInput(event.target.value)}
                placeholder="教师 id（留空 = 全平台）"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyTeacherDrillDown();
                }}
              />
              <button type="button" className="secondary-action" onClick={applyTeacherDrillDown}>应用</button>
              {teacherId ? (
                <button type="button" className="secondary-action" onClick={clearTeacherFilter}>清除</button>
              ) : null}
            </div>
          </div>
          <span className="admin-list-total">
            {teacherId ? `教师 ${teacherId} · ${rangeLabel}` : `全平台 · ${rangeLabel}`}
          </span>
        </div>

        {loading ? <p className="muted" role="status">正在加载用量（{rangeLabel}）…</p> : null}
        {!loading && error ? (
          <div className="admin-usage-error" role="alert">
            <p>用量加载失败：{error}</p>
            <button type="button" className="secondary-action" onClick={() => load()}>重试</button>
          </div>
        ) : null}
        {!loading && !error && summary && summary.totals.totalTokens === 0 && summary.totals.requests === 0 ? (
          <p className="muted admin-usage-empty" role="status">
            {teacherId ? '该教师在所选时段暂无用量数据。' : '该时段平台暂无用量数据。'}
          </p>
        ) : null}

        {!loading && !error && summary && (summary.totals.totalTokens > 0 || summary.totals.requests > 0) ? (
          <>
            <div className="admin-usage-metrics">
              <UsageMetric label="总 Token" value={summary.totals.totalTokens} />
              <UsageMetric label="输入 Token" value={summary.totals.promptTokens} />
              <UsageMetric label="输出 Token" value={summary.totals.completionTokens} />
              <UsageMetric label="请求次数" value={summary.totals.requests} />
            </div>

            <div className="admin-usage-breakdown">
              <h3>按 Provider 明细</h3>
              {summary.byProvider.length === 0 ? (
                <p className="muted">该时段暂无 Provider 用量明细。</p>
              ) : (
                <div className="admin-usage-table-wrap">
                  <table className="admin-usage-table">
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">模型</th>
                        <th scope="col">输入</th>
                        <th scope="col">输出</th>
                        <th scope="col">合计</th>
                        <th scope="col">请求数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byProvider.map((row) => (
                        <UsageRow key={`${row.providerName}|${row.model}`} row={row} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function UsageMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-usage-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString('zh-CN')}</strong>
    </div>
  );
}

function UsageRow({ row }: { row: AdminUsageSummaryRow }) {
  return (
    <tr>
      <td data-label="Provider">{row.providerName}</td>
      <td data-label="模型">{row.model}</td>
      <td data-label="输入">{row.promptTokens.toLocaleString('zh-CN')}</td>
      <td data-label="输出">{row.completionTokens.toLocaleString('zh-CN')}</td>
      <td data-label="合计">{row.totalTokens.toLocaleString('zh-CN')}</td>
      <td data-label="请求数">{row.requests.toLocaleString('zh-CN')}</td>
    </tr>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
