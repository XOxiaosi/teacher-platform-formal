import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import {
  createRequirement,
  listRequirements,
  updateRequirement,
  type RequirementCategory,
  type RequirementData,
  type RequirementPriority,
} from '../../api/requirements';
import { formatDateTime } from '../../shared/date-format';
import './user-feedback.css';

/**
 * ============================================================================
 * 页面架构评审（简版，按 harness/rules/frontend-development.md 门禁）
 * ============================================================================
 * 1. 展示内容与业务目标
 *    - 目标：教师通过网页提交结构化用户反馈（bug/需求/体验…），并回看自己提交的
 *      反馈与处理状态；对接 t46 已建的 UserRequirement API（owner 隔离）。
 *    - 依据：D51 §9.1 反馈模板（类型/标题/描述/期望行为/截图可选/优先级自评）。
 * 2. 信息层级与导航关系
 *    - 路由：/feedback-submit（辅助导航「用户反馈」，authed 保护，App 路由守卫已有）。
 *    - 层级：页首 hero（用户反馈）→ 反馈表单卡片 → 我的反馈列表卡片。
 *    - 与既有「家长反馈 /feedback」页面路由区分（对象不同：平台产品反馈 vs 家长沟通）。
 * 3. 功能模块与边界
 *    - 提交模块：类型（category 7 类白名单）、标题（contextSummary）、描述（verbatimQuote，
 *      必填）、期望行为（parsedIntent）、优先级自评（priority 4 级）；截图阶段一不做上传，
 *      文案说明（out of scope）。
 *    - 列表模块：GET /requirements（自己的 + 平台级只读）；状态徽标（status 5 态）、
 *      提交时间、分类/优先级；自己的记录可编辑（乐观锁 PATCH category/priority）。
 *    - 字段映射（前端表单 → 后端契约）：描述→verbatimQuote、标题→contextSummary、
 *      期望行为→parsedIntent；后端 verbatimQuote 不可改（追溯留证）。
 * 4. 关键交互路径与异常状态
 *    - 提交：必填校验（标题/描述）→ POST → 成功清空表单并刷新列表；失败显示错误条。
 *    - 编辑：仅自己的记录；保存带 expectedUpdatedAt（乐观锁）；VERSION_CONFLICT →
 *      「已被其他操作更新」并刷新列表；加载/空数据/失败态齐全。
 * 5. 验收标准
 *    - 表单校验/提交调用/列表渲染/乐观锁编辑测试；前端全量测试 + tsc 绿。
 * 6. 明确不做（out of scope）
 *    - 管理员看板（§9.2 后台面板线）、截图上传、微信端表单、平台级记录编辑。
 * ============================================================================
 */

const CATEGORY_LABELS: Record<RequirementCategory, string> = {
  feature: '功能建议',
  improvement: '体验优化',
  bug_report: '问题反馈',
  ux: '界面体验',
  performance: '性能问题',
  privacy: '隐私安全',
  other: '其他',
};

const PRIORITY_LABELS: Record<RequirementPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

const STATUS_LABELS: Record<string, string> = {
  new: '新提交',
  triaged: '已评估',
  in_progress: '处理中',
  done: '已解决',
  archived: '已关闭',
};

interface FeedbackFormState {
  category: RequirementCategory;
  title: string;
  description: string;
  expectedBehavior: string;
  priority: RequirementPriority;
}

const initialForm: FeedbackFormState = {
  category: 'feature',
  title: '',
  description: '',
  expectedBehavior: '',
  priority: 'normal',
};

interface UserFeedbackPageProps {
  teacherId: string;
}

export function UserFeedbackPage({ teacherId }: UserFeedbackPageProps) {
  const [form, setForm] = useState<FeedbackFormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const [items, setItems] = useState<RequirementData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ category: RequirementCategory; priority: RequirementPriority } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listRequirements(teacherId)
      .then((result) => setItems(result.items))
      .catch((error: unknown) => setLoadError(messageOf(error)))
      .finally(() => setLoading(false));
  }, [teacherId]);

  useEffect(() => {
    load();
  }, [load]);

  const canSubmit = form.title.trim().length > 0
    && form.description.trim().length > 0
    && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      await createRequirement(teacherId, {
        verbatimQuote: form.description.trim(),
        contextSummary: form.title.trim(),
        parsedIntent: form.expectedBehavior.trim() || undefined,
        category: form.category,
        priority: form.priority,
      });
      setForm(initialForm);
      setSubmitSuccess(true);
      load();
    } catch (error) {
      setSubmitError(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  }

  function updateField<K extends keyof FeedbackFormState>(field: K, value: FeedbackFormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function startEdit(item: RequirementData) {
    setEditingId(item.id);
    setEditDraft({
      category: item.category as RequirementCategory,
      priority: item.priority as RequirementPriority,
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  async function saveEdit(item: RequirementData) {
    if (!editDraft) return;
    setSavingId(item.id);
    setEditError(null);
    try {
      const updated = await updateRequirement(teacherId, item.id, {
        expectedUpdatedAt: item.updatedAtTs,
        changes: editDraft,
      });
      setItems((current) => current.map((entry) => (entry.id === item.id ? updated : entry)));
      cancelEdit();
    } catch (error) {
      if (error instanceof ApiError && error.error.code === 'VERSION_CONFLICT') {
        setEditError('保存失败：这条反馈已被其他操作更新，请刷新后重试');
        load();
      } else {
        setEditError(`保存失败：${messageOf(error)}`);
      }
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="user-feedback-page">
      <header className="page-hero">
        <p className="eyebrow">渠道线 · 用户反馈</p>
        <h2>用户反馈</h2>
        <p>提交你遇到的 bug、功能建议或体验问题，帮助改进教学平台；已提交反馈的处理状态会展示在下方列表。</p>
      </header>

      <form className="page-card feedback-form feedback-form-card" onSubmit={handleSubmit}>
        <h3>提交反馈</h3>
        <div className="feedback-form-grid">
          <label htmlFor="feedback-category">
            反馈类型
            <select
              id="feedback-category"
              value={form.category}
              onChange={(event) => updateField('category', event.target.value as RequirementCategory)}
            >
              {(Object.keys(CATEGORY_LABELS) as RequirementCategory[]).map((category) => (
                <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>
              ))}
            </select>
          </label>
          <label htmlFor="feedback-priority">
            优先级自评
            <select
              id="feedback-priority"
              value={form.priority}
              onChange={(event) => updateField('priority', event.target.value as RequirementPriority)}
            >
              {(Object.keys(PRIORITY_LABELS) as RequirementPriority[]).map((priority) => (
                <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>
              ))}
            </select>
          </label>
        </div>
        <label htmlFor="feedback-title">
          标题
          <input
            id="feedback-title"
            value={form.title}
            onChange={(event) => updateField('title', event.target.value)}
            placeholder="一句话概括问题或建议"
            required
          />
        </label>
        <label htmlFor="feedback-description">
          描述
          <textarea
            id="feedback-description"
            value={form.description}
            onChange={(event) => updateField('description', event.target.value)}
            placeholder="详细说明你遇到的问题或想要的改进"
            required
          />
        </label>
        <label htmlFor="feedback-expected">
          期望行为（可选）
          <textarea
            id="feedback-expected"
            value={form.expectedBehavior}
            onChange={(event) => updateField('expectedBehavior', event.target.value)}
            placeholder="你期望发生什么、怎样算解决"
          />
        </label>
        <p className="feedback-screenshot-hint">截图上传暂未开放（阶段一），可在描述中补充截图位置或相关信息。</p>
        {submitError ? <p className="feedback-form-error" role="alert">提交失败：{submitError}</p> : null}
        {submitSuccess ? <p className="feedback-form-success" role="status">已提交，感谢反馈。</p> : null}
        <button className="primary-action" type="submit" disabled={!canSubmit}>
          {submitting ? '提交中…' : '提交反馈'}
        </button>
      </form>

      <article className="page-card feedback-list-card">
        <h3>我的反馈</h3>
        {loading ? <p className="muted">正在加载反馈列表</p> : null}
        {!loading && loadError ? (
          <p className="feedback-form-error" role="alert">列表加载失败：{loadError}</p>
        ) : null}
        {!loading && !loadError && items.length === 0 ? (
          <p className="muted">还没有提交过反馈。</p>
        ) : null}
        {!loading && !loadError && items.length > 0 ? (
          <ul className="feedback-requirement-list">
            {items.map((item) => (
              <RequirementListItem
                key={item.id}
                item={item}
                editable={item.teacherId === teacherId}
                editing={editingId === item.id}
                draft={editDraft}
                saving={savingId === item.id}
                editError={editingId === item.id ? editError : null}
                onStartEdit={() => startEdit(item)}
                onCancelEdit={cancelEdit}
                onDraftChange={setEditDraft}
                onSave={() => void saveEdit(item)}
              />
            ))}
          </ul>
        ) : null}
      </article>
    </section>
  );
}

interface RequirementListItemProps {
  item: RequirementData;
  editable: boolean;
  editing: boolean;
  draft: { category: RequirementCategory; priority: RequirementPriority } | null;
  saving: boolean;
  editError: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (draft: { category: RequirementCategory; priority: RequirementPriority }) => void;
  onSave: () => void;
}

function RequirementListItem({
  item,
  editable,
  editing,
  draft,
  saving,
  editError,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSave,
}: RequirementListItemProps) {
  const category = item.category as RequirementCategory;
  const priority = item.priority as RequirementPriority;
  return (
    <li className="requirement-item">
      <div className="requirement-item-head">
        <span className={`status-badge feedback-status-badge feedback-status-badge--${item.status}`}>
          {STATUS_LABELS[item.status] ?? item.status}
        </span>
        <span className="requirement-item-category">{CATEGORY_LABELS[category] ?? item.category}</span>
        <span className={`requirement-item-priority requirement-item-priority--${item.priority}`}>
          {PRIORITY_LABELS[priority] ?? item.priority}
        </span>
        <time className="requirement-item-time" dateTime={item.createdAtTs}>{formatDateTime(item.createdAtTs)}</time>
        {editable && !editing ? (
          <button type="button" className="requirement-item-edit" onClick={onStartEdit}>编辑</button>
        ) : null}
      </div>
      <strong className="requirement-item-title">{item.contextSummary || item.verbatimQuote}</strong>
      <p className="requirement-item-description">{item.verbatimQuote}</p>
      {item.parsedIntent ? <p className="requirement-item-expected">期望行为：{item.parsedIntent}</p> : null}
      {editing && draft ? (
        <div className="requirement-edit-row">
          <label>
            类型
            <select
              value={draft.category}
              onChange={(event) => onDraftChange({ ...draft, category: event.target.value as RequirementCategory })}
            >
              {(Object.keys(CATEGORY_LABELS) as RequirementCategory[]).map((option) => (
                <option key={option} value={option}>{CATEGORY_LABELS[option]}</option>
              ))}
            </select>
          </label>
          <label>
            优先级
            <select
              value={draft.priority}
              onChange={(event) => onDraftChange({ ...draft, priority: event.target.value as RequirementPriority })}
            >
              {(Object.keys(PRIORITY_LABELS) as RequirementPriority[]).map((option) => (
                <option key={option} value={option}>{PRIORITY_LABELS[option]}</option>
              ))}
            </select>
          </label>
          <button type="button" className="primary-action" disabled={saving} onClick={onSave}>
            {saving ? '保存中' : '保存'}
          </button>
          <button type="button" className="secondary-action" disabled={saving} onClick={onCancelEdit}>取消</button>
          {editError ? <p className="feedback-form-error" role="alert">{editError}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
