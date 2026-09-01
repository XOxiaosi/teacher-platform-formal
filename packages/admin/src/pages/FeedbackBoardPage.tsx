import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFeedbackSummary,
  listFeedback,
  updateFeedbackLinks,
  updateFeedbackStatus,
  type FeedbackBoardItem,
  type FeedbackCategory,
  type FeedbackPriority,
  type FeedbackStatus,
  type FeedbackSummary,
} from '../api/adminFeedback';
import { formatDateTime } from '../shared/date-format';
import '../styles/admin.css';
import '../styles/feedback-board.css';

const PAGE_SIZE = 10;

const STATUS_OPTIONS: FeedbackStatus[] = ['new', 'triaged', 'in_progress', 'done', 'archived'];
const PRIORITY_OPTIONS: FeedbackPriority[] = ['low', 'normal', 'high', 'urgent'];
const CATEGORY_OPTIONS: FeedbackCategory[] = [
  'feature',
  'improvement',
  'bug_report',
  'ux',
  'performance',
  'privacy',
  'other',
];

/** 状态流转方向（new → triaged → in_progress → done）；archived 为终态不展示流转按钮。 */
const FLOW_ORDER: FeedbackStatus[] = ['new', 'triaged', 'in_progress', 'done'];

const statusLabels: Record<FeedbackStatus, string> = {
  new: '待处理',
  triaged: '评估中',
  in_progress: '已排期',
  done: '已完成',
  archived: '已关闭',
};

const priorityLabels: Record<FeedbackPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

const categoryLabels: Record<FeedbackCategory, string> = {
  feature: '功能',
  improvement: '改进',
  bug_report: '缺陷',
  ux: '体验',
  performance: '性能',
  privacy: '隐私',
  other: '其他',
};

export function FeedbackBoardPage() {
  const [items, setItems] = useState<FeedbackBoardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<FeedbackCategory | ''>('');
  const [priorityFilter, setPriorityFilter] = useState<FeedbackPriority | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listFeedback({
      page,
      pageSize: PAGE_SIZE,
      status: statusFilter === '' ? undefined : statusFilter,
      category: categoryFilter === '' ? undefined : categoryFilter,
      priority: priorityFilter === '' ? undefined : priorityFilter,
    })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((loadError: unknown) => setError(messageOf(loadError)))
      .finally(() => setLoading(false));
  }, [page, statusFilter, categoryFilter, priorityFilter]);

  const loadSummary = useCallback(() => {
    setSummaryError(null);
    getFeedbackSummary()
      .then(setSummary)
      .catch((summaryLoadError: unknown) => setSummaryError(messageOf(summaryLoadError)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }

  function setFilter(kind: 'status' | 'category' | 'priority', value: string) {
    if (kind === 'status') setStatusFilter(value as FeedbackStatus | '');
    if (kind === 'category') setCategoryFilter(value as FeedbackCategory | '');
    if (kind === 'priority') setPriorityFilter(value as FeedbackPriority | '');
    setPage(1);
  }

  function resetFilters() {
    setStatusFilter('');
    setCategoryFilter('');
    setPriorityFilter('');
    setPage(1);
  }

  async function handleStatusChange(item: FeedbackBoardItem, next: FeedbackStatus) {
    const nextLabel = statusLabels[next];
    if (!window.confirm(
      `确定将反馈「${truncate(item.verbatimQuote, 24)}」状态流转为「${nextLabel}」？该操作将写入审计日志。`,
    )) return;
    setUpdatingId(item.id);
    setActionError(null);
    try {
      await updateFeedbackStatus({
        requirementId: item.id,
        expectedUpdatedAt: item.updatedAtTs,
        status: next,
      });
      showToast(`已更新为「${nextLabel}」，审计已记录`);
      setExpandedId(null);
      await load();
      await loadSummary();
    } catch (updateError) {
      const message = messageOf(updateError);
      setActionError(
        message.includes('VERSION_CONFLICT') || message.includes('已被他人更新')
          ? '状态更新失败：该反馈已被其他管理员更新，请刷新后重试'
          : `状态更新失败：${message}`,
      );
    } finally {
      setUpdatingId(null);
    }
  }

  /** 保存关联工件（设计文档/任务/提交）：只传与当前值不同的字段；全部清空视为清除关联。 */
  async function handleSaveLinks(item: FeedbackBoardItem, draft: LinkDraft) {
    const changes: Record<string, string> = {};
    if (draft.linkedDesignDoc !== (item.linkedDesignDoc ?? '')) changes.linkedDesignDoc = draft.linkedDesignDoc;
    if (draft.linkedTaskId !== (item.linkedTaskId ?? '')) changes.linkedTaskId = draft.linkedTaskId;
    if (draft.linkedCommitSha !== (item.linkedCommitSha ?? '')) changes.linkedCommitSha = draft.linkedCommitSha;
    if (Object.keys(changes).length === 0) return; // 无变更（按钮已禁用，双保险）
    setUpdatingId(item.id);
    setActionError(null);
    try {
      await updateFeedbackLinks({
        requirementId: item.id,
        expectedUpdatedAt: item.updatedAtTs,
        ...changes,
      });
      showToast('关联信息已保存，审计已记录');
      await load();
      await loadSummary();
    } catch (updateError) {
      const message = messageOf(updateError);
      setActionError(
        message.includes('VERSION_CONFLICT') || message.includes('已被他人更新')
          ? '关联保存失败：该反馈已被其他管理员更新，请刷新后重试'
          : `关联保存失败：${message}`,
      );
    } finally {
      setUpdatingId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilter = statusFilter !== '' || categoryFilter !== '' || priorityFilter !== '';

  return (
    <section className="admin-page feedback-board-page">
      <header className="page-hero">
        <p className="eyebrow">后台管理 · 反馈</p>
        <h2>反馈看板</h2>
        <p>集中查看教师提交的用户反馈（UserRequirement），按状态/分类/优先级筛选、评估与排期。</p>
      </header>

      {toast ? <p className="admin-action-toast feedback-toast" role="status">{toast}</p> : null}

      <SummaryStrip
        summary={summary}
        error={summaryError}
        statusFilter={statusFilter}
        categoryFilter={categoryFilter}
        priorityFilter={priorityFilter}
        onFilter={setFilter}
      />

      <div className="page-card feedback-list-card">
        <div className="admin-list-toolbar feedback-toolbar">
          <div className="feedback-filters">
            <label>
              状态
              <select
                value={statusFilter}
                onChange={(event) => setFilter('status', event.target.value)}
              >
                <option value="">全部</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{statusLabels[status]}</option>
                ))}
              </select>
            </label>
            <label>
              分类
              <select
                value={categoryFilter}
                onChange={(event) => setFilter('category', event.target.value)}
              >
                <option value="">全部</option>
                {CATEGORY_OPTIONS.map((category) => (
                  <option key={category} value={category}>{categoryLabels[category]}</option>
                ))}
              </select>
            </label>
            <label>
              优先级
              <select
                value={priorityFilter}
                onChange={(event) => setFilter('priority', event.target.value)}
              >
                <option value="">全部</option>
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>{priorityLabels[priority]}</option>
                ))}
              </select>
            </label>
            <button type="button" className="secondary-action feedback-reset" onClick={resetFilters}>
              重置
            </button>
          </div>
          <span className="admin-list-total">共 {total} 条反馈</span>
        </div>

        {loading ? <p className="muted">正在加载反馈</p> : null}
        {!loading && error ? <p className="admin-error" role="alert">列表加载失败：{error}</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="muted">暂无反馈记录{hasActiveFilter ? '（当前筛选下）' : ''}。</p>
        ) : null}

        {!loading && !error && items.length > 0 ? (
          <div className="feedback-table-wrap">
            <table className="feedback-table">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">原话</th>
                  <th scope="col">意图</th>
                  <th scope="col">分类</th>
                  <th scope="col">优先级</th>
                  <th scope="col">状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <FeedbackRow
                    key={item.id}
                    item={item}
                    expanded={expandedId === item.id}
                    updating={updatingId === item.id}
                    onToggle={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                    onStatusChange={(next) => void handleStatusChange(item, next)}
                    onSaveLinks={(draft) => void handleSaveLinks(item, draft)}
                  />
                ))}
              </tbody>
            </table>
          </div>
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

        {actionError ? <p className="admin-error feedback-action-error" role="alert">{actionError}</p> : null}
      </div>
    </section>
  );
}

function SummaryStrip({
  summary,
  error,
  statusFilter,
  categoryFilter,
  priorityFilter,
  onFilter,
}: {
  summary: FeedbackSummary | null;
  error: string | null;
  statusFilter: FeedbackStatus | '';
  categoryFilter: FeedbackCategory | '';
  priorityFilter: FeedbackPriority | '';
  onFilter: (kind: 'status' | 'category' | 'priority', value: string) => void;
}) {
  return (
    <section className="feedback-summary" aria-label="反馈汇总">
      <div className="feedback-summary-metric">
        <span>总反馈</span>
        <strong>{summary?.total ?? '—'}</strong>
      </div>

      <DistributionList
        title="按状态"
        entries={summary?.byStatus ?? []}
        labelOf={(status) => statusLabels[status as FeedbackStatus] ?? status}
        activeValue={statusFilter}
        onPick={(value) => onFilter('status', value)}
      />
      <DistributionList
        title="按优先级"
        entries={summary?.byPriority ?? []}
        labelOf={(priority) => priorityLabels[priority as FeedbackPriority] ?? priority}
        activeValue={priorityFilter}
        onPick={(value) => onFilter('priority', value)}
      />
      <DistributionList
        title="按分类"
        entries={summary?.byCategory ?? []}
        labelOf={(category) => categoryLabels[category as FeedbackCategory] ?? category}
        activeValue={categoryFilter}
        onPick={(value) => onFilter('category', value)}
      />

      {error ? <p className="admin-error" role="alert">汇总加载失败：{error}</p> : null}
    </section>
  );
}

function DistributionList({
  title,
  entries,
  labelOf,
  activeValue,
  onPick,
}: {
  title: string;
  entries: Array<{ status?: string; priority?: string; category?: string; count: number }>;
  labelOf: (value: string) => string;
  activeValue: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="feedback-distribution">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="muted feedback-distribution-empty">暂无数据</p>
      ) : (
        <ul>
          {entries.map((entry) => {
            const value = entry.status ?? entry.priority ?? entry.category ?? '';
            const active = value === activeValue;
            return (
              <li key={value}>
                <button
                  type="button"
                  className={active ? 'feedback-chip active' : 'feedback-chip'}
                  onClick={() => onPick(active ? '' : value)}
                >
                  {labelOf(value)} <strong>{entry.count}</strong>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 关联工件草稿（与 FeedbackBoardItem.linked* 同语义，输入框值用空串表示「无」）。 */
interface LinkDraft {
  linkedDesignDoc: string;
  linkedTaskId: string;
  linkedCommitSha: string;
}

interface FeedbackRowProps {
  item: FeedbackBoardItem;
  expanded: boolean;
  updating: boolean;
  onToggle: () => void;
  onStatusChange: (next: FeedbackStatus) => void;
  onSaveLinks: (draft: LinkDraft) => void;
}

function FeedbackRow({ item, expanded, updating, onToggle, onStatusChange, onSaveLinks }: FeedbackRowProps) {
  const nextStatuses = nextFlowStatuses(item.status);
  return (
    <>
      <tr className="feedback-row">
        <td data-label="时间"><time dateTime={item.occurredAtTs}>{formatDateTime(item.occurredAtTs)}</time></td>
        <td data-label="原话" className="feedback-quote-cell">{truncate(item.verbatimQuote, 40)}</td>
        <td data-label="意图" className="feedback-intent-cell">{item.parsedIntent ?? '—'}</td>
        <td data-label="分类"><span className="feedback-category">{categoryLabel(item.category)}</span></td>
        <td data-label="优先级"><PriorityBadge priority={item.priority} /></td>
        <td data-label="状态"><StatusBadge status={item.status} /></td>
        <td data-label="操作">
          <button type="button" className="secondary-action feedback-toggle" onClick={onToggle}>
            {expanded ? '收起' : '详情'}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="feedback-detail-row">
          <td colSpan={7}>
            <FeedbackDetail
              item={item}
              updating={updating}
              nextStatuses={nextStatuses}
              onStatusChange={onStatusChange}
              onSaveLinks={onSaveLinks}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FeedbackDetail({
  item,
  updating,
  nextStatuses,
  onStatusChange,
  onSaveLinks,
}: {
  item: FeedbackBoardItem;
  updating: boolean;
  nextStatuses: FeedbackStatus[];
  onStatusChange: (next: FeedbackStatus) => void;
  onSaveLinks: (draft: LinkDraft) => void;
}) {
  return (
    <div className="feedback-detail">
      <dl className="feedback-detail-dl">
        <div>
          <dt>原话</dt>
          <dd className="feedback-verbatim">{item.verbatimQuote}</dd>
        </div>
        <div>
          <dt>上下文摘要</dt>
          <dd>{item.contextSummary ?? '—'}</dd>
        </div>
        <div>
          <dt>解析意图</dt>
          <dd>{item.parsedIntent ?? '—'}</dd>
        </div>
        <div>
          <dt>发生时间</dt>
          <dd><time dateTime={item.occurredAtTs}>{formatDateTime(item.occurredAtTs)}</time></dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{sourceText(item)}</dd>
        </div>
        <div>
          <dt>创建 / 更新</dt>
          <dd>{formatDateTime(item.createdAtTs)} / {formatDateTime(item.updatedAtTs)}</dd>
        </div>
        <div>
          <dt>关联</dt>
          <dd>{linkedText(item)}</dd>
        </div>
      </dl>

      <LinkEditor item={item} updating={updating} onSaveLinks={onSaveLinks} />

      <div className="feedback-flow-actions">
        <span className="admin-action-tip">状态流转（审计：feedback.triage/.schedule/.complete）：</span>
        {nextStatuses.length === 0 ? (
          <span className="muted">当前状态已为终态（{statusLabels[item.status as FeedbackStatus] ?? item.status}）。</span>
        ) : (
          nextStatuses.map((next) => (
            <button
              key={next}
              type="button"
              className="secondary-action"
              disabled={updating}
              onClick={() => onStatusChange(next)}
            >
              {updating ? '处理中…' : statusLabels[next]}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** 关联工件编辑器：设计文档/任务 ID/提交 SHA 三个输入 + 保存（空值 = 清除关联；无变更时按钮禁用）。 */
function LinkEditor({
  item,
  updating,
  onSaveLinks,
}: {
  item: FeedbackBoardItem;
  updating: boolean;
  onSaveLinks: (draft: LinkDraft) => void;
}) {
  const [draft, setDraft] = useState<LinkDraft>(linkDraftOf(item));

  // 保存成功后列表已重载（item 值变化）→ 草稿同步回最新值
  useEffect(() => {
    setDraft(linkDraftOf(item));
  }, [item.id, item.linkedDesignDoc, item.linkedTaskId, item.linkedCommitSha]);

  const dirty =
    draft.linkedDesignDoc !== (item.linkedDesignDoc ?? '')
    || draft.linkedTaskId !== (item.linkedTaskId ?? '')
    || draft.linkedCommitSha !== (item.linkedCommitSha ?? '');

  function updateField(field: keyof LinkDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="feedback-link-editor" aria-label="关联工件">
      <h4>关联工件（设计文档 / 任务 / 提交；留空并保存 = 清除该项关联）</h4>
      <div className="feedback-link-fields">
        <label htmlFor={`link-doc-${item.id}`}>
          设计文档
          <input
            id={`link-doc-${item.id}`}
            type="text"
            value={draft.linkedDesignDoc}
            onChange={(event) => updateField('linkedDesignDoc', event.target.value)}
            placeholder="docs/xxx.md"
            disabled={updating}
          />
        </label>
        <label htmlFor={`link-task-${item.id}`}>
          任务 ID
          <input
            id={`link-task-${item.id}`}
            type="text"
            value={draft.linkedTaskId}
            onChange={(event) => updateField('linkedTaskId', event.target.value)}
            placeholder="T-101"
            disabled={updating}
          />
        </label>
        <label htmlFor={`link-commit-${item.id}`}>
          提交 SHA
          <input
            id={`link-commit-${item.id}`}
            type="text"
            value={draft.linkedCommitSha}
            onChange={(event) => updateField('linkedCommitSha', event.target.value)}
            placeholder="abc1234"
            disabled={updating}
          />
        </label>
      </div>
      <button
        type="button"
        className="secondary-action feedback-link-save"
        disabled={updating || !dirty}
        onClick={() => onSaveLinks(draft)}
      >
        {updating ? '保存中…' : '保存关联'}
      </button>
    </div>
  );
}

function linkDraftOf(item: FeedbackBoardItem): LinkDraft {
  return {
    linkedDesignDoc: item.linkedDesignDoc ?? '',
    linkedTaskId: item.linkedTaskId ?? '',
    linkedCommitSha: item.linkedCommitSha ?? '',
  };
}

function StatusBadge({ status }: { status: string }) {
  const label = statusLabels[status as FeedbackStatus] ?? status;
  return <span className={`status-badge feedback-status--${status}`}>{label}</span>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const label = priorityLabels[priority as FeedbackPriority] ?? priority;
  return <span className={`status-badge feedback-priority--${priority}`}>{label}</span>;
}

/** 返回当前状态之后可流转的目标状态（按 FLOW_ORDER 顺序，跳过终态 archived）。 */
function nextFlowStatuses(current: string): FeedbackStatus[] {
  const currentIndex = FLOW_ORDER.indexOf(current as FeedbackStatus);
  if (currentIndex === -1) return [];
  return FLOW_ORDER.slice(currentIndex + 1);
}

function sourceText(item: FeedbackBoardItem): string {
  const parts = [item.sourceType ?? '平台级', item.sourceDbName ?? '', item.sourceTurnId ?? ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function linkedText(item: FeedbackBoardItem): string {
  const parts = [
    item.linkedDesignDoc ? `设计：${item.linkedDesignDoc}` : '',
    item.linkedTaskId ? `任务：${item.linkedTaskId}` : '',
    item.linkedCommitSha ? `提交：${item.linkedCommitSha}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : '—';
}

function categoryLabel(category: string): string {
  return categoryLabels[category as FeedbackCategory] ?? category;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
