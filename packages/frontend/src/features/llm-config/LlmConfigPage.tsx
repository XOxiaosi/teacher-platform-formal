import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  createProviderConfig,
  getUsageSummary,
  listProviderConfigs,
  removeProviderConfig,
  setPrimaryProviderConfig,
  testProviderConfig,
  updateProviderConfig,
} from '../../api/providerConfigs';
import type {
  ProviderConfigDto,
  ProviderErrorKind,
  UsageSummary,
  UsageSummaryRow,
} from '../../api/types';
import {
  USAGE_RANGES,
  usageBuckets,
  usageRangeSpec,
  usageWindow,
  type UsageRangeKey,
} from './usage-window';
import {
  loadTestHistory,
  removeTestHistory,
  saveTestHistory,
  type TestHistoryEntry,
} from './test-history';
import { formatDateTime } from '../../shared/date-format';
import './llm-config.css';

interface LlmConfigPageProps {
  teacherId: string;
}

interface CreateFormState {
  providerKind: 'openai' | 'anthropic';
  providerName: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const initialCreateForm: CreateFormState = {
  providerKind: 'openai',
  providerName: '',
  displayName: '',
  baseUrl: '',
  apiKey: '',
  model: '',
};

interface EditFormState {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 常用厂商清单（datalist 提示；教师可自由输入自定义 baseUrl 对应厂商名）。 */
const COMMON_PROVIDER_NAMES = [
  'deepseek',
  'qwen',
  'zhipu',
  'ark',
  'kimi',
  'siliconflow',
  'openrouter',
  'moonshot',
  'anthropic',
  'openai',
];

const providerKindLabels: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
};

const providerErrorKindLabels: Record<ProviderErrorKind, string> = {
  auth: '密钥无效（401/403）',
  rate_limited: '请求受限（429）',
  timeout: '连接超时',
  invalid_request: '请求参数错误',
  provider_down: '服务不可用',
  model_not_found: '模型不存在',
  unknown: '未知错误',
};

export function LlmConfigPage({ teacherId }: LlmConfigPageProps) {
  const [providers, setProviders] = useState<ProviderConfigDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [trend, setTrend] = useState<TrendBucket[]>([]);
  const [usageRange, setUsageRange] = useState<UsageRangeKey>('30d');
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateFormState>(initialCreateForm);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForms, setEditForms] = useState<Record<string, EditFormState>>({});
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const [testingId, setTestingId] = useState<string | null>(null);
  // 测试结果历史（本地持久化：最近测试时间 + 结果；无密钥敏感信息；测试完成即写入，刷新后仍可见）
  const [testHistory, setTestHistory] = useState<Record<string, TestHistoryEntry>>(
    () => loadTestHistory(teacherId),
  );

  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    listProviderConfigs(teacherId)
      .then((items) => {
        if (active) setProviders(items);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(messageOf(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [teacherId]);

  // 用量看板：整窗口 summary（指标卡 + byProvider）+ 趋势分桶（每桶一次 summary 聚合）
  const loadUsage = useCallback((target: UsageRangeKey) => {
    setUsageLoading(true);
    setUsageError(null);
    const spec = usageRangeSpec(target);
    const now = new Date();
    const { from, to } = usageWindow(spec.days, now);
    const buckets = usageBuckets(spec, now);

    Promise.all([
      getUsageSummary(teacherId, from.toISOString(), to.toISOString()),
      ...buckets.map((bucket) => getUsageSummary(teacherId, bucket.from.toISOString(), bucket.to.toISOString())),
    ])
      .then(([summary, ...bucketSummaries]) => {
        setUsage(summary);
        setTrend(buckets.map((bucket, index) => ({
          label: bucket.label,
          totalTokens: bucketSummaries[index]?.totals.totalTokens ?? 0,
          requests: bucketSummaries[index]?.totals.requests ?? 0,
        })));
      })
      .catch((error: unknown) => {
        setUsageError(messageOf(error));
      })
      .finally(() => {
        setUsageLoading(false);
      });
  }, [teacherId]);

  useEffect(() => {
    loadUsage(usageRange);
  }, [loadUsage, usageRange]);

  async function reloadProviders() {
    try {
      const items = await listProviderConfigs(teacherId);
      setProviders(items);
    } catch (error) {
      setActionError(messageOf(error));
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setCreateError(null);
    try {
      const created = await createProviderConfig(teacherId, {
        providerKind: createForm.providerKind,
        providerName: createForm.providerName.trim(),
        displayName: createForm.displayName.trim() || undefined,
        baseUrl: createForm.baseUrl.trim(),
        apiKey: createForm.apiKey,
        model: createForm.model.trim(),
      });
      // 首条自动 primary：同步本地标记，避免出现两个「主 LLM」徽标
      setProviders((current) => [
        ...current.map((config) => (created.isPrimary ? { ...config, isPrimary: false } : config)),
        created,
      ]);
      setCreateForm(initialCreateForm);
    } catch (error) {
      setCreateError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(config: ProviderConfigDto) {
    setEditingId(config.id);
    setEditError(null);
    setEditForms((current) => ({
      ...current,
      [config.id]: {
        displayName: config.displayName ?? '',
        baseUrl: config.baseUrl,
        apiKey: '',
        model: config.model,
      },
    }));
  }

  function updateEditField(id: string, field: keyof EditFormState, value: string) {
    setEditForms((current) => ({
      ...current,
      [id]: { ...current[id], [field]: value },
    }));
  }

  async function handleSaveEdit(config: ProviderConfigDto) {
    const form = editForms[config.id];
    if (!form) return;
    setSavingEditId(config.id);
    setEditError(null);
    try {
      const updated = await updateProviderConfig(teacherId, config.id, {
        displayName: form.displayName.trim() || undefined,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        apiKey: form.apiKey.trim() || undefined, // 留空则不修改密钥
      });
      setProviders((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
    } catch (error) {
      setEditError(messageOf(error));
    } finally {
      setSavingEditId(null);
    }
  }

  async function handleRemove(config: ProviderConfigDto) {
    const hint = config.isPrimary
      ? '删除主 LLM 后：若还有其他配置则自动提升其一为默认，否则回退至平台默认模型。'
      : '删除后该配置将不再可用。';
    if (!window.confirm(`确定删除「${configDisplayName(config)}」？${hint}`)) return;
    setActionError(null);
    try {
      await removeProviderConfig(teacherId, config.id);
      // 删除配置时同步清理其测试历史，避免残留条目
      setTestHistory(removeTestHistory(teacherId, config.id));
      await reloadProviders();
    } catch (error) {
      setActionError(messageOf(error));
    }
  }

  async function handleSetPrimary(config: ProviderConfigDto) {
    setActionError(null);
    try {
      await setPrimaryProviderConfig(teacherId, config.id);
      await reloadProviders();
    } catch (error) {
      setActionError(messageOf(error));
    }
  }

  async function handleTest(config: ProviderConfigDto) {
    setTestingId(config.id);
    setActionError(null);
    try {
      const result = await testProviderConfig(teacherId, config.id);
      // 记录「最近测试」：时间由前端记录（后端 test 端点不返回时间戳），本地持久化
      const entry: TestHistoryEntry = { testedAt: new Date().toISOString(), result };
      setTestHistory(saveTestHistory(teacherId, config.id, entry));
    } catch (error) {
      setActionError(`连通性测试失败：${messageOf(error)}`);
    } finally {
      setTestingId(null);
    }
  }

  if (loading) {
    return <section className="llm-config-page page-card">正在加载 LLM 配置</section>;
  }

  if (loadError) {
    return (
      <section className="llm-config-page page-card llm-config-error" role="alert">
        <p className="eyebrow">Error</p>
        <h2>LLM 配置加载失败</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  // 主 LLM 置顶展示；其余按创建时间升序（稳定排序，同优先级保持后端返回顺序）
  const sortedProviders = [...providers].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAtTs.localeCompare(b.createdAtTs),
  );

  return (
    <section className="llm-config-page">
      <header className="page-hero">
        <p className="eyebrow">模型渠道</p>
        <h2>LLM 配置</h2>
        <p>管理你的大模型渠道（API Key 加密存储、只写不回），选择主 LLM 并查看用量与趋势。</p>
      </header>

      {actionError ? <p className="llm-action-error" role="alert">操作失败：{actionError}</p> : null}

      <UsageDashboard
        range={usageRange}
        usage={usage}
        trend={trend}
        loading={usageLoading}
        error={usageError}
        onRangeChange={setUsageRange}
        onRetry={() => loadUsage(usageRange)}
      />

      <form className="page-card llm-create-form" onSubmit={handleCreate}>
        <h3>新增 Provider</h3>
        {providers.length === 0 ? (
          <p className="llm-first-hint" role="status">当前还没有任何配置——新增的第一条将自动设为主 LLM。</p>
        ) : null}
        <div className="llm-form-grid">
          <label htmlFor="llm-provider-kind">
            协议族
            <select
              id="llm-provider-kind"
              value={createForm.providerKind}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  providerKind: event.target.value === 'anthropic' ? 'anthropic' : 'openai',
                }))
              }
              required
            >
              <option value="openai">OpenAI 兼容（DeepSeek/通义/智谱/豆包等）</option>
              <option value="anthropic">Anthropic（Claude）</option>
            </select>
          </label>
          <label htmlFor="llm-provider-name">
            Provider 名称
            <input
              id="llm-provider-name"
              type="text"
              list="llm-common-providers"
              value={createForm.providerName}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, providerName: event.target.value }))
              }
              placeholder="deepseek"
              required
            />
            <datalist id="llm-common-providers">
              {COMMON_PROVIDER_NAMES.map((name) => <option key={name} value={name} />)}
            </datalist>
          </label>
          <label htmlFor="llm-display-name">
            显示名称（可选）
            <input
              id="llm-display-name"
              type="text"
              value={createForm.displayName}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, displayName: event.target.value }))
              }
              placeholder="例如：主力 DeepSeek"
            />
          </label>
          <label htmlFor="llm-base-url">
            Base URL
            <input
              id="llm-base-url"
              type="url"
              value={createForm.baseUrl}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, baseUrl: event.target.value }))
              }
              placeholder="https://api.deepseek.com"
              required
            />
          </label>
          <label htmlFor="llm-api-key">
            API Key
            <input
              id="llm-api-key"
              type="password"
              autoComplete="new-password"
              value={createForm.apiKey}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, apiKey: event.target.value }))
              }
              placeholder="sk-..."
              required
            />
          </label>
          <label htmlFor="llm-model">
            模型
            <input
              id="llm-model"
              type="text"
              value={createForm.model}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, model: event.target.value }))
              }
              placeholder="deepseek-chat"
              required
            />
          </label>
        </div>
        {createError ? <p className="llm-form-error" role="alert">新增失败：{createError}</p> : null}
        <button className="primary-action" type="submit" disabled={saving}>
          {saving ? '保存中' : '新增配置'}
        </button>
      </form>

      <article className="page-card llm-list-card">
        <h3>Provider 列表</h3>
        {providers.length === 0 ? (
          <p className="muted">暂无 LLM 配置。新增第一条配置将自动设为主 LLM（平台默认模型将被替换）。</p>
        ) : (
          <div className="llm-provider-list">
            {sortedProviders.map((config) => (
              <ProviderCard
                key={config.id}
                config={config}
                editing={editingId === config.id}
                editForm={editForms[config.id]}
                savingEdit={savingEditId === config.id}
                editError={editError}
                testing={testingId === config.id}
                testEntry={testHistory[config.id]}
                onEditFieldChange={(field, value) => updateEditField(config.id, field, value)}
                onBeginEdit={() => beginEdit(config)}
                onSaveEdit={() => void handleSaveEdit(config)}
                onCancelEdit={() => {
                  setEditingId(null);
                  setEditError(null);
                }}
                onSetPrimary={() => void handleSetPrimary(config)}
                onTest={() => void handleTest(config)}
                onRemove={() => void handleRemove(config)}
              />
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

interface TrendBucket {
  label: string;
  totalTokens: number;
  requests: number;
}

interface UsageDashboardProps {
  range: UsageRangeKey;
  usage: UsageSummary | null;
  trend: TrendBucket[];
  loading: boolean;
  error: string | null;
  onRangeChange: (range: UsageRangeKey) => void;
  onRetry: () => void;
}

function UsageDashboard({
  range,
  usage,
  trend,
  loading,
  error,
  onRangeChange,
  onRetry,
}: UsageDashboardProps) {
  const rangeLabel = usageRangeSpec(range).label;
  return (
    <section className="page-card llm-usage-card" aria-label="用量看板">
      <div className="llm-usage-toolbar">
        <h3>用量看板</h3>
        <div className="llm-range-switch" role="group" aria-label="时间段切换">
          {USAGE_RANGES.map((spec) => (
            <button
              key={spec.key}
              type="button"
              className={range === spec.key ? 'active' : ''}
              aria-pressed={range === spec.key}
              onClick={() => onRangeChange(spec.key)}
            >
              {spec.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="muted" role="status">正在加载用量（{rangeLabel}）…</p>
      ) : error ? (
        <div className="llm-usage-error" role="alert">
          <p>用量加载失败：{error}</p>
          <button type="button" className="secondary-action" onClick={onRetry}>重试</button>
        </div>
      ) : usage && usage.totals.totalTokens === 0 && usage.totals.requests === 0 ? (
        <p className="muted llm-usage-empty" role="status">该时段（{rangeLabel}）暂无用量数据。</p>
      ) : usage ? (
        <>
          <div className="llm-usage-grid">
            <UsageMetric label="总 Token" value={usage.totals.totalTokens} />
            <UsageMetric label="输入 Token" value={usage.totals.promptTokens} />
            <UsageMetric label="输出 Token" value={usage.totals.completionTokens} />
            <UsageMetric label="请求次数" value={usage.totals.requests} />
          </div>

          <TrendChart buckets={trend} />

          {usage.byProvider.length > 0 ? (
            <div className="llm-usage-breakdown">
              <h4>按 Provider 用量</h4>
              <ProviderUsageBars rows={usage.byProvider} />
              <table className="llm-usage-table">
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
                  {usage.byProvider.map((row) => <UsageRow key={`${row.providerName}|${row.model}`} row={row} />)}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** 趋势简图：CSS 柱状（无图表库依赖），按分桶 totalTokens 归一高度。 */
function TrendChart({ buckets }: { buckets: TrendBucket[] }) {
  const max = Math.max(...buckets.map((bucket) => bucket.totalTokens), 1);
  const hasAny = buckets.some((bucket) => bucket.totalTokens > 0);
  return (
    <div className="llm-trend" aria-label="用量趋势">
      <h4>用量趋势</h4>
      {!hasAny ? (
        <p className="muted llm-trend-empty">该时段暂无用量。</p>
      ) : (
        <div className="llm-trend-bars">
          {buckets.map((bucket) => (
            <div
              key={bucket.label}
              className="llm-trend-col"
              title={`${bucket.label}：${bucket.totalTokens.toLocaleString('zh-CN')} token / ${bucket.requests.toLocaleString('zh-CN')} 次请求`}
            >
              <span className="llm-trend-value">{compactNumber(bucket.totalTokens)}</span>
              <div className="llm-trend-track">
                <div
                  className="llm-trend-bar"
                  style={{ height: `${Math.max(6, Math.round((bucket.totalTokens / max) * 100))}%` }}
                />
              </div>
              <span className="llm-trend-label">{bucket.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Provider 维度条形分布（byProvider 按 providerName 聚合，totalTokens 归一）。 */
function ProviderUsageBars({ rows }: { rows: UsageSummaryRow[] }) {
  const byProvider = aggregateByProvider(rows);
  const max = Math.max(...byProvider.map((entry) => entry.totalTokens), 1);
  if (byProvider.length === 0) return null;
  return (
    <div className="llm-provider-bars" aria-label="按 Provider 用量分布">
      {byProvider.map((entry) => (
        <div key={entry.providerName} className="llm-provider-bar-row">
          <span className="llm-provider-bar-name">{entry.providerName}</span>
          <div className="llm-provider-bar-track">
            <div
              className="llm-provider-bar"
              style={{ width: `${Math.max(2, Math.round((entry.totalTokens / max) * 100))}%` }}
            />
          </div>
          <span className="llm-provider-bar-value">
            {entry.totalTokens.toLocaleString('zh-CN')} · {entry.requests.toLocaleString('zh-CN')} 次
          </span>
        </div>
      ))}
    </div>
  );
}

function aggregateByProvider(rows: UsageSummaryRow[]): Array<{ providerName: string; totalTokens: number; requests: number }> {
  const map = new Map<string, { providerName: string; totalTokens: number; requests: number }>();
  for (const row of rows) {
    const entry = map.get(row.providerName) ?? { providerName: row.providerName, totalTokens: 0, requests: 0 };
    entry.totalTokens += row.totalTokens;
    entry.requests += row.requests;
    map.set(row.providerName, entry);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** 紧凑数值：>=1 万 → x.x万；否则原值。 */
function compactNumber(value: number): string {
  if (value >= 10000) {
    const scaled = value / 10000;
    return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}万`;
  }
  return value.toLocaleString('zh-CN');
}

function UsageMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="llm-usage-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString('zh-CN')}</strong>
    </div>
  );
}

function UsageRow({ row }: { row: UsageSummaryRow }) {
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

interface ProviderCardProps {
  config: ProviderConfigDto;
  editing: boolean;
  editForm: EditFormState | undefined;
  savingEdit: boolean;
  editError: string | null;
  testing: boolean;
  /** 最近一次测试记录（含前端记录的时间；localStorage 持久化，刷新后仍在）。 */
  testEntry: TestHistoryEntry | undefined;
  onEditFieldChange: (field: keyof EditFormState, value: string) => void;
  onBeginEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onSetPrimary: () => void;
  onTest: () => void;
  onRemove: () => void;
}

function ProviderCard({
  config,
  editing,
  editForm,
  savingEdit,
  editError,
  testing,
  testEntry,
  onEditFieldChange,
  onBeginEdit,
  onSaveEdit,
  onCancelEdit,
  onSetPrimary,
  onTest,
  onRemove,
}: ProviderCardProps) {
  return (
    <div className={`llm-provider-card${config.status === 'disabled' ? ' disabled' : ''}`}>
      <div className="llm-provider-head">
        <div>
          <h4>{configDisplayName(config)}</h4>
          <p className="llm-provider-meta">
            {providerKindLabels[config.providerKind] ?? config.providerKind} · {config.model}
          </p>
        </div>
        <div className="llm-provider-badges">
          {config.isPrimary ? <span className="llm-badge primary">主 LLM</span> : null}
          <span className={config.status === 'disabled' ? 'llm-badge disabled' : 'llm-badge active'}>
            {config.status === 'disabled' ? '已禁用' : '启用'}
          </span>
        </div>
      </div>
      <dl className="llm-provider-details">
        <div>
          <dt>Base URL</dt>
          <dd>{config.baseUrl}</dd>
        </div>
        <div>
          <dt>API Key</dt>
          <dd><code>{config.apiKeyMasked}</code></dd>
        </div>
      </dl>

      {editing && editForm ? (
        <div className="llm-edit-form">
          <label htmlFor={`llm-edit-display-${config.id}`}>
            显示名称
            <input
              id={`llm-edit-display-${config.id}`}
              type="text"
              value={editForm.displayName}
              onChange={(event) => onEditFieldChange('displayName', event.target.value)}
            />
          </label>
          <label htmlFor={`llm-edit-base-${config.id}`}>
            Base URL
            <input
              id={`llm-edit-base-${config.id}`}
              type="url"
              value={editForm.baseUrl}
              onChange={(event) => onEditFieldChange('baseUrl', event.target.value)}
            />
          </label>
          <label htmlFor={`llm-edit-model-${config.id}`}>
            模型
            <input
              id={`llm-edit-model-${config.id}`}
              type="text"
              value={editForm.model}
              onChange={(event) => onEditFieldChange('model', event.target.value)}
            />
          </label>
          <label htmlFor={`llm-edit-key-${config.id}`}>
            API Key（留空不修改）
            <input
              id={`llm-edit-key-${config.id}`}
              type="password"
              autoComplete="new-password"
              value={editForm.apiKey}
              onChange={(event) => onEditFieldChange('apiKey', event.target.value)}
              placeholder="留空保持不变"
            />
          </label>
          {editError ? <p className="llm-form-error" role="alert">保存失败：{editError}</p> : null}
          <div className="llm-edit-actions">
            <button className="primary-action" type="button" onClick={onSaveEdit} disabled={savingEdit}>
              {savingEdit ? '保存中' : '保存'}
            </button>
            <button className="secondary-action" type="button" onClick={onCancelEdit} disabled={savingEdit}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {testEntry ? <TestResultLine entry={testEntry} /> : null}

      <div className="llm-provider-actions">
        {!config.isPrimary ? (
          <button className="secondary-action" type="button" onClick={onSetPrimary} disabled={editing}>
            设为主 LLM
          </button>
        ) : null}
        <button className="secondary-action" type="button" onClick={onTest} disabled={testing || editing}>
          {testing ? '测试中…' : '测试连通性'}
        </button>
        <button className="secondary-action" type="button" onClick={onBeginEdit} disabled={testing}>
          编辑
        </button>
        <button className="danger-action" type="button" onClick={onRemove} disabled={testing || editing}>
          删除
        </button>
      </div>
    </div>
  );
}

function TestResultLine({ entry }: { entry: TestHistoryEntry }) {
  const when = formatDateTime(entry.testedAt);
  if (entry.result.ok) {
    return (
      <p className="llm-test-result ok" role="status">
        最近测试（{when}）：连通正常：{entry.result.providerName ?? ''} / {entry.result.model ?? ''}
      </p>
    );
  }
  const error = entry.result.providerError;
  return (
    <p className="llm-test-result fail" role="alert">
      最近测试（{when}）：连通失败：
      {error
        ? `${providerErrorKindLabels[error.kind] ?? error.kind}（${error.status}）· ${error.message}`
        : '未知错误'}
    </p>
  );
}

function configDisplayName(config: ProviderConfigDto): string {
  return config.displayName || config.providerName;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
