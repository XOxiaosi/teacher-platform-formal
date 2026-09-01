import { FormEvent, useCallback, useEffect, useState } from 'react';
import { generateFeedbackDraft, createFeedback, listFeedbacks, getFeedbackSnapshot } from '../../api/feedback';
import type { FeedbackEvidenceItem, GenerateFeedbackDraftResult, SavedFeedback, FeedbackSnapshotData } from '../../api/feedback';
import { listStudents } from '../../api/students';
import type { StudentData } from '../../api/types';
import { formatDate, formatDateTime } from '../../shared/date-format';
import { ModerationFlag } from '../../shared/moderation-flag';
import './feedback.css';

interface FeedbackPageProps {
  teacherId: string;
}

type FeedbackTone = 'formal' | 'warm' | 'concise';
type ClassSize = '1v1' | 'small' | 'large';
type ParentType = 'normal' | 'scores' | 'sensitive';
type FeedbackFocus = 'highlight' | 'problem' | 'cooperation' | 'summary';

const toneOptions: Array<{ value: FeedbackTone; label: string }> = [
  { value: 'formal', label: '正式' },
  { value: 'warm', label: '温暖' },
  { value: 'concise', label: '简洁' },
];

const classSizeOptions: Array<{ value: ClassSize; label: string }> = [
  { value: '1v1', label: '1对1' },
  { value: 'small', label: '小班' },
  { value: 'large', label: '大班' },
];

const parentTypeOptions: Array<{ value: ParentType; label: string }> = [
  { value: 'normal', label: '普通' },
  { value: 'scores', label: '只认分' },
  { value: 'sensitive', label: '玻璃心' },
];

const focusOptions: Array<{ value: FeedbackFocus; label: string }> = [
  { value: 'highlight', label: '高光进步' },
  { value: 'problem', label: '发现问题' },
  { value: 'cooperation', label: '需家长配合' },
  { value: 'summary', label: '阶段小结' },
];

const evidenceTypeLabels: Record<string, string> = {
  assessment: '成绩',
  record: '档案',
  lesson: '课程',
};

const statusLabels: Record<string, string> = {
  draft: '草稿',
  reviewed: '已复核',
  sent: '已发送',
  archived: '已归档',
};

export function FeedbackPage({ teacherId }: FeedbackPageProps) {
  const [students, setStudents] = useState<StudentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [studentId, setStudentId] = useState('');
  const [tone, setTone] = useState<FeedbackTone>('warm');
  const [classSize, setClassSize] = useState<ClassSize | ''>('');
  const [parentType, setParentType] = useState<ParentType | ''>('');
  const [focus, setFocus] = useState<FeedbackFocus | ''>('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [draft, setDraft] = useState<GenerateFeedbackDraftResult | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [savedList, setSavedList] = useState<SavedFeedback[]>([]);
  const [savedTotal, setSavedTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<FeedbackSnapshotData | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    listStudents(teacherId)
      .then((result) => {
        if (!active) return;
        setStudents(result.items);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(messageOf(error));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => { active = false; };
  }, [teacherId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedStudentId = studentId.trim();
    if (!selectedStudentId) return;

    setGenerating(true);
    setGenerateError(null);
    setDraft(null);
    setTitle('');
    setContent('');
    setSaveSuccess(false);
    setSaveError(null);

    try {
      const body: Parameters<typeof generateFeedbackDraft>[1] = {
        studentId: selectedStudentId,
        tone,
      };
      if (classSize) body.classSize = classSize;
      if (parentType) body.parentType = parentType;
      if (focus) body.focus = focus;
      const result = await generateFeedbackDraft(teacherId, body);
      setDraft(result);
      setTitle(result.title);
      setContent(result.content);
    } catch (error) {
      setGenerateError(messageOf(error));
    } finally {
      setGenerating(false);
    }
  }

  const loadSavedFeedbacks = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const result = await listFeedbacks(teacherId, { pageSize: 20 });
      setSavedList(result.items);
      setSavedTotal(result.total);
    } catch (error) {
      setListError(messageOf(error));
    } finally {
      setListLoading(false);
    }
  }, [teacherId]);

  useEffect(() => {
    let active = true;
    loadSavedFeedbacks().then(() => {
      if (!active) return;
    });
    return () => { active = false; };
  }, [loadSavedFeedbacks]);

  async function handleSave() {
    if (!draft) return;
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (!trimmedTitle || !trimmedContent) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      await createFeedback(teacherId, {
        studentId: draft.studentId,
        title: trimmedTitle,
        content: trimmedContent,
        evidence: draft.evidence,
        windowStart: draft.windowStart,
        windowEnd: draft.windowEnd,
      });
      setSaveSuccess(true);
      setSaveError(null);
      await loadSavedFeedbacks();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleExpand(feedbackId: string) {
    if (expandedId === feedbackId) {
      setExpandedId(null);
      setSnapshot(null);
      setSnapshotError(null);
      return;
    }
    setExpandedId(feedbackId);
    setSnapshot(null);
    setSnapshotError(null);
    setSnapshotLoading(true);
    try {
      const data = await getFeedbackSnapshot(teacherId, feedbackId);
      setSnapshot(data);
    } catch (error) {
      setSnapshotError(messageOf(error));
    } finally {
      setSnapshotLoading(false);
    }
  }

  if (loading) {
    return <section className="feedback-page page-card">正在加载学生</section>;
  }

  if (loadError) {
    return (
      <section className="feedback-page page-card feedback-error" role="alert">
        <p className="eyebrow">Error</p>
        <h2>学生加载失败</h2>
        <p>{loadError}</p>
      </section>
    );
  }

  if (students.length === 0) {
    return (
      <section className="feedback-page">
        <header className="page-hero">
          <p className="eyebrow">家长反馈</p>
          <h2>反馈助手</h2>
          <p>选择学生与语气，为家长生成一份可编辑的反馈草稿。</p>
        </header>
        <section className="page-card empty-state">
          <h3>暂无学生</h3>
          <p>请先在学生页添加学生，再回来生成反馈草稿。</p>
        </section>
      </section>
    );
  }

  return (
    <section className="feedback-page">
      <header className="page-hero">
        <p className="eyebrow">家长反馈</p>
        <h2>反馈助手</h2>
        <p>选择学生与语气，为家长生成一份可编辑的反馈草稿。</p>
      </header>

      <form className="page-card feedback-form" onSubmit={handleSubmit}>
        <h3>生成反馈草稿</h3>
        <div className="feedback-form-grid">
          <label htmlFor="feedback-student-id">
            学生
            <select
              id="feedback-student-id"
              value={studentId}
              onChange={(event) => setStudentId(event.target.value)}
              required
            >
              <option value="">请选择学生</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.name} · {student.grade}</option>
              ))}
            </select>
          </label>
          <label htmlFor="feedback-tone">
            语气
            <select
              id="feedback-tone"
              value={tone}
              onChange={(event) => setTone(event.target.value as FeedbackTone)}
            >
              {toneOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label htmlFor="feedback-class-size">
            班型
            <select
              id="feedback-class-size"
              value={classSize}
              onChange={(event) => setClassSize(event.target.value as ClassSize | '')}
            >
              <option value="">留空（按默认）</option>
              {classSizeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label htmlFor="feedback-parent-type">
            家长类型
            <select
              id="feedback-parent-type"
              value={parentType}
              onChange={(event) => setParentType(event.target.value as ParentType | '')}
            >
              <option value="">留空（按默认）</option>
              {parentTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label htmlFor="feedback-focus">
            反馈目标
            <select
              id="feedback-focus"
              value={focus}
              onChange={(event) => setFocus(event.target.value as FeedbackFocus | '')}
            >
              <option value="">留空（按默认）</option>
              {focusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        {generateError ? <p className="feedback-form-error" role="alert">生成失败：{generateError}</p> : null}
        <button
          className="primary-action"
          type="submit"
          disabled={!studentId.trim() || generating}
        >
          {generating ? '生成中…' : '生成反馈草稿'}
        </button>
      </form>

      {draft ? (
        <article className="page-card feedback-draft">
          <h3>反馈草稿</h3>
          <p className="feedback-draft-hint">草稿由 AI 生成，请核对后发送。</p>
          <label htmlFor="feedback-title">
            标题
            <input
              id="feedback-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label htmlFor="feedback-content">
            内容
            <textarea
              id="feedback-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          {title.trim() && content.trim() ? (
            <div className="feedback-save-row">
              <button
                className="primary-action feedback-save-btn"
                type="button"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存反馈'}
              </button>
              {saveSuccess ? <span className="feedback-save-success">已保存</span> : null}
              {saveError ? <span className="feedback-save-error" role="alert">保存失败：{saveError}</span> : null}
            </div>
          ) : null}
          {draft.rationale ? (
            <p className="feedback-draft-rationale">
              <span className="feedback-draft-rationale-label">所以这样写：</span>
              {draft.rationale}
            </p>
          ) : null}
          {draft.evidence && draft.evidence.length > 0 ? (
            <EvidenceSection evidence={draft.evidence} windowStart={draft.windowStart} windowEnd={draft.windowEnd} />
          ) : null}
        </article>
      ) : null}

      <section className="page-card feedback-saved">
        <h3>已保存反馈</h3>
        {listLoading ? (
          <p className="feedback-saved-hint">加载中…</p>
        ) : listError ? (
          <p className="feedback-error" role="alert">列表加载失败：{listError}</p>
        ) : savedList.length === 0 ? (
          <p className="feedback-saved-empty">还没有保存的反馈</p>
        ) : (
          <ul className="feedback-saved-list">
            {savedList.map((item) => {
              const studentName = students.find((s) => s.id === item.studentId)?.name ?? item.studentId;
              const isExpanded = expandedId === item.id;
              return (
                <li key={item.id} className="feedback-saved-item">
                  <div className="feedback-saved-item-head">
                    <div className="feedback-saved-item-main">
                      <span className="feedback-saved-title">{item.title}</span>
                      <span className={`feedback-status-badge feedback-status-badge--${item.status}`}>
                        {statusLabels[item.status] ?? item.status}
                      </span>
                    </div>
                    <div className="feedback-saved-item-meta">
                      <span className="feedback-saved-student">{studentName}</span>
                      <time className="feedback-saved-date" dateTime={item.createdAt}>
                        {formatDateTime(item.createdAt)}
                      </time>
                      <button
                        type="button"
                        className="feedback-expand-btn"
                        aria-expanded={isExpanded}
                        aria-controls={`feedback-snapshot-${item.id}`}
                        onClick={() => handleToggleExpand(item.id)}
                      >
                        {isExpanded ? '收起依据' : '查看依据'}
                      </button>
                    </div>
                  </div>
                  <ModerationFlag flagged={item.moderationFlagged} reasons={item.moderationReasons} />
                  {isExpanded ? (
                    <div id={`feedback-snapshot-${item.id}`} className="feedback-snapshot-panel">
                      {snapshotLoading ? (
                        <p className="feedback-saved-hint">加载依据中…</p>
                      ) : snapshotError ? (
                        <p className="feedback-snapshot-empty" role="alert">{snapshotError}</p>
                      ) : snapshot ? (
                        <EvidenceSection
                          evidence={snapshot.evidence}
                          windowStart={snapshot.windowStart ?? undefined}
                          windowEnd={snapshot.windowEnd ?? undefined}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {savedTotal > 0 && !listLoading && !listError ? (
          <p className="feedback-saved-total">共 {savedTotal} 条</p>
        ) : null}
      </section>
    </section>
  );
}

// ---- 证据来源区块 ----
function EvidenceSection({
  evidence,
  windowStart,
  windowEnd,
}: {
  evidence: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
}) {
  return (
    <div className="feedback-evidence">
      <div className="feedback-evidence-head">
        <h4>证据来源（本次反馈引用的记录）</h4>
        <p className="feedback-evidence-hint">
          草稿基于以下已确认记录生成，可核对。
          {windowStart && windowEnd
            ? ` 时间范围：${formatDate(windowStart)} ~ ${formatDate(windowEnd)}`
            : null}
        </p>
      </div>
      <ul className="feedback-evidence-list">
        {evidence.map((item) => (
          <li key={item.id} className="feedback-evidence-item">
            <div className="feedback-evidence-item-head">
              <span className={`evidence-type-badge evidence-type-badge--${item.type}`}>
                {evidenceTypeLabels[item.type] ?? item.type}
              </span>
              <time className="feedback-evidence-date" dateTime={item.occurredAt}>
                {formatDate(item.occurredAt)}
              </time>
            </div>
            {item.summary ? <p className="feedback-evidence-summary">{item.summary}</p> : null}
            {item.type === 'assessment' && item.score !== null ? (
              <div className="feedback-evidence-assessment">
                {item.subject ? <span className="evidence-subject">{item.subject}</span> : null}
                <span className="evidence-score">
                  {item.score}
                  {item.fullScore !== null ? `/${item.fullScore}` : ''}
                </span>
                {item.examName ? <span className="evidence-exam">{item.examName}</span> : null}
                {item.previousScore !== null ? (
                  <span className="evidence-prev-score">上次 {item.previousScore}</span>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
