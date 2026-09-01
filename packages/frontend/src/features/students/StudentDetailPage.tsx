import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  captureCommunicationFromText,
  captureScoreFromText,
  getStudentTimeline,
  listStudentRecords,
  listStudents,
  reviewStudentRecord,
  updateCommunicationDetail,
} from '../../api/students';
import type {
  CommunicationDetailPatch,
  CommunicationExtraction,
  ScoreExtraction,
  StudentData,
  StudentRecordItem,
  TimelineCommunicationDetail,
  TimelineEntry,
} from '../../api/types';
import { studentStatusLabel } from '../../shared/display-labels';
import { ModerationFlag } from '../../shared/moderation-flag';
import './student-detail.css';

interface StudentDetailPageProps {
  teacherId: string;
  studentId: string;
  onNavigate: (path: string) => void;
}

// ---- 本地标签映射 ----
const timelineTypeLabels: Record<string, string> = {
  record: '档案',
  assessment: '成绩',
  lesson: '课次',
  feedback: '反馈',
};

const reviewStatusLabels: Record<string, string> = {
  candidate: '待审核',
  confirmed: '已确认',
  rejected: '已驳回',
  auto_confirmed: '已自动确认',
};

const recordCategoryLabels: Record<string, string> = {
  assessment: '成绩',
  lesson_observation: '课堂观察',
  parent_communication: '家长沟通',
  learning_state: '学习状态',
  homework: '作业',
  goal: '目标',
  achievement: '成就',
  concern: '关注点',
  agreement: '约定',
  follow_up: '跟进',
  general_note: '普通记录',
};

// ---- 家长沟通标签映射 ----
const communicationDirectionLabels: Record<string, string> = {
  inbound: '打进',
  outbound: '打出',
  two_way: '双向',
};

const communicationChannelLabels: Record<string, string> = {
  phone: '电话',
  wechat: '微信',
  offline: '线下',
  other: '其它',
};

const communicationParentTypeLabels: Record<string, string> = {
  normal: '普通',
  scores: '只认分',
  sensitive: '玻璃心',
};

export function StudentDetailPage({ teacherId, studentId, onNavigate }: StudentDetailPageProps) {
  // ---- 学生基础信息 ----
  const [student, setStudent] = useState<StudentData | null>(null);
  const [studentLoading, setStudentLoading] = useState(true);
  const [studentError, setStudentError] = useState<string | null>(null);

  // ---- 时间线 ----
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // ---- 档案记录 ----
  const [records, setRecords] = useState<StudentRecordItem[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);

  // ---- 文字记成绩 ----
  const [rawText, setRawText] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureResult, setCaptureResult] = useState<ScoreExtraction | null>(null);

  // ---- 记家长沟通 ----
  const [commRawText, setCommRawText] = useState('');
  const [commCapturing, setCommCapturing] = useState(false);
  const [commCaptureError, setCommCaptureError] = useState<string | null>(null);
  const [commCaptureResult, setCommCaptureResult] = useState<CommunicationExtraction | null>(null);

  // ---- 审核操作状态 ----
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // ---- 加载学生基础信息 ----
  useEffect(() => {
    let active = true;
    setStudentLoading(true);
    setStudentError(null);
    setStudent(null);
    listStudents(teacherId)
      .then((result) => {
        if (!active) return;
        const found = result.items.find((s) => s.id === studentId) ?? null;
        if (!found) {
          setStudentError('未找到该学生（可能不属于当前老师）');
        } else {
          setStudent(found);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStudentError(messageOf(error));
      })
      .finally(() => {
        if (!active) return;
        setStudentLoading(false);
      });
    return () => { active = false; };
  }, [teacherId, studentId]);

  // ---- 加载时间线 + 档案记录 ----
  function loadDetailData() {
    let active = true;

    // 时间线
    setTimelineLoading(true);
    setTimelineError(null);
    getStudentTimeline(teacherId, studentId)
      .then((result) => {
        if (!active) return;
        setTimeline(result.items);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setTimelineError(messageOf(error));
      })
      .finally(() => {
        if (!active) return;
        setTimelineLoading(false);
      });

    // 档案记录
    setRecordsError(null);
    listStudentRecords(teacherId, studentId)
      .then((result) => {
        if (!active) return;
        setRecords(result.items);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRecordsError(messageOf(error));
      });

    return () => { active = false; };
  }

  useEffect(loadDetailData, [teacherId, studentId]);

  // ---- 计算派生数据 ----
  const sortedTimeline = useMemo(() => {
    return [...timeline].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }, [timeline]);

  const assessmentEntries = useMemo(
    () => sortedTimeline.filter((e) => e.type === 'assessment'),
    [sortedTimeline],
  );

  const pendingReviewRecords = useMemo(
    () => records.filter((r) => r.reviewStatus === 'candidate'),
    [records],
  );

  // ---- 文字记成绩 ----
  async function handleCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = rawText.trim();
    if (!text) return;

    setCapturing(true);
    setCaptureError(null);
    setCaptureResult(null);

    try {
      const result = await captureScoreFromText(teacherId, studentId, text);
      setCaptureResult(result.extraction);
      setRawText('');
      // 刷新时间线和档案
      loadDetailData();
    } catch (error) {
      setCaptureError(messageOf(error));
    } finally {
      setCapturing(false);
    }
  }

  // ---- 记家长沟通 ----
  async function handleCommCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = commRawText.trim();
    if (!text) return;

    setCommCapturing(true);
    setCommCaptureError(null);
    setCommCaptureResult(null);

    try {
      const result = await captureCommunicationFromText(teacherId, studentId, { rawText: text });
      setCommCaptureResult(result.extraction);
      setCommRawText('');
      // 刷新时间线和档案
      loadDetailData();
    } catch (error) {
      setCommCaptureError(messageOf(error));
    } finally {
      setCommCapturing(false);
    }
  }

  // ---- 审核记录 ----
  async function handleReview(recordId: string, reviewStatus: 'confirmed' | 'rejected') {
    setReviewingId(recordId);
    setReviewError(null);

    try {
      const args: Parameters<typeof reviewStudentRecord> = [teacherId, studentId, recordId, reviewStatus];
      if (reviewStatus === 'confirmed') {
        args.push('parent_shareable');
      }
      const updated = await reviewStudentRecord(...args);
      setRecords((current) =>
        current.map((r) => (r.id === recordId ? updated : r)),
      );
      // 同步刷新时间线
      setTimelineLoading(true);
      setTimelineError(null);
      const timelineResult = await getStudentTimeline(teacherId, studentId);
      setTimeline(timelineResult.items);
    } catch (error) {
      setReviewError(`${reviewStatus === 'confirmed' ? '确认' : '驳回'}失败：${messageOf(error)}`);
    } finally {
      setTimelineLoading(false);
      setReviewingId(null);
    }
  }

  // ---- 顶部错误：学生不存在或加载失败 ----
  if (studentLoading) {
    return (
      <section className="student-detail-page page-card">
        正在加载学生信息
      </section>
    );
  }

  if (studentError) {
    return (
      <section className="student-detail-page page-card danger-card" role="alert">
        <p className="eyebrow">Error</p>
        <h2>学生信息加载失败</h2>
        <p>{studentError}</p>
        <button className="secondary-action" type="button" onClick={() => onNavigate('/students')}>
          返回学生列表
        </button>
      </section>
    );
  }

  if (!student) {
    return null;
  }

  return (
    <section className="student-detail-page">
      {/* 顶部概览 */}
      <header className="page-hero detail-hero">
        <button
          className="detail-back-link"
          type="button"
          onClick={() => onNavigate('/students')}
          aria-label="返回学生列表"
        >
          ← 返回列表
        </button>
        <p className="eyebrow">学生详情</p>
        <div className="detail-hero-title-row">
          <h2>{student.name}</h2>
          <span className={`status-badge status-badge--${student.currentStatus}`}>
            {studentStatusLabel(student.currentStatus)}
          </span>
        </div>
        <div className="detail-hero-meta">
          <span>年级：{student.grade}</span>
          <span>阶段目标：{student.stageGoal ?? '未设置'}</span>
        </div>
      </header>

      {/* 文字记成绩（闭环入口） */}
      <section className="page-card detail-capture-card" aria-labelledby="capture-title">
        <h3 id="capture-title">文字记成绩</h3>
        <p className="muted">粘贴一句话（如「物理月考 83/100，上次 78」），自动识别并归档。</p>
        <form onSubmit={handleCapture}>
          <label htmlFor="capture-text" className="sr-only">成绩文本</label>
          <textarea
            id="capture-text"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="例如：物理月考 83/100，上次 78 分"
            className="detail-capture-textarea"
            rows={3}
          />
          <div className="detail-capture-actions">
            <button
              className="primary-action"
              type="submit"
              disabled={!rawText.trim() || capturing}
            >
              {capturing ? '识别中…' : '识别并归档'}
            </button>
          </div>
          {captureError ? (
            <p className="detail-message danger" role="alert">{captureError}</p>
          ) : null}
          {captureResult ? (
            <div className="detail-capture-result" role="status">
              <p className="detail-message success">
                已归档：
                {captureResult.subject ?? '未知科目'}
                {captureResult.score !== undefined ? ` ${captureResult.score}` : ''}
                {captureResult.fullScore !== undefined ? `/${captureResult.fullScore}` : ''}
                {captureResult.examName ? ` ${captureResult.examName}` : ''}
              </p>
            </div>
          ) : null}
        </form>
      </section>

      {/* 记家长沟通 */}
      <section className="page-card detail-capture-card detail-comm-capture-card" aria-labelledby="comm-capture-title">
        <h3 id="comm-capture-title">记家长沟通</h3>
        <p className="muted">粘贴一句沟通描述（如「小强妈妈打电话说作业太多，约了下周再聊」），自动识别并归档。</p>
        <form onSubmit={handleCommCapture}>
          <label htmlFor="comm-capture-text" className="sr-only">家长沟通文本</label>
          <textarea
            id="comm-capture-text"
            value={commRawText}
            onChange={(e) => setCommRawText(e.target.value)}
            placeholder="例如：小强妈妈打电话说作业太多，约了下周再聊"
            className="detail-capture-textarea"
            rows={3}
          />
          <div className="detail-capture-actions">
            <button
              className="primary-action"
              type="submit"
              disabled={!commRawText.trim() || commCapturing}
            >
              {commCapturing ? '识别中…' : '识别并归档'}
            </button>
          </div>
          {commCaptureError ? (
            <p className="detail-message danger" role="alert">{commCaptureError}</p>
          ) : null}
          {commCaptureResult ? (
            <div className="detail-capture-result" role="status">
              <p className="detail-message success">
                已归档：
                {commCaptureResult.direction ? `${communicationDirectionLabels[commCaptureResult.direction] ?? commCaptureResult.direction} ` : ''}
                {commCaptureResult.channel ? `${communicationChannelLabels[commCaptureResult.channel] ?? commCaptureResult.channel} ` : ''}
                沟通
              </p>
            </div>
          ) : null}
        </form>
      </section>

      {/* 成绩（从时间线筛出） */}
      <section className="page-card detail-scores-card" aria-labelledby="scores-title">
        <h3 id="scores-title">成绩记录</h3>
        <ScoresList entries={assessmentEntries} loading={timelineLoading} error={timelineError} />
      </section>

      {/* 时间线（核心） */}
      <section className="page-card detail-timeline-card" aria-labelledby="timeline-title">
        <h3 id="timeline-title">时间线</h3>
        <TimelineList
          entries={sortedTimeline}
          loading={timelineLoading}
          error={timelineError}
          emptyHint="还没有记录，试试在上方粘贴一句话记成绩"
          teacherId={teacherId}
          studentId={studentId}
          onDataChanged={loadDetailData}
        />
      </section>

      {/* 档案记录 + 审核 */}
      <section className="page-card detail-records-card" aria-labelledby="records-title">
        <div className="detail-card-header">
          <h3 id="records-title">档案审核</h3>
          {pendingReviewRecords.length > 0 ? (
            <span className="detail-badge-pending">{pendingReviewRecords.length} 待审核</span>
          ) : null}
        </div>
        {reviewError ? <p className="detail-message danger" role="alert">{reviewError}</p> : null}
        {recordsError ? (
          <p className="detail-message danger">档案记录加载失败：{recordsError}</p>
        ) : (
          <RecordsList
            records={records}
            reviewingId={reviewingId}
            onReview={handleReview}
          />
        )}
      </section>
    </section>
  );
}

// ---- 时间线列表 ----
function TimelineList({
  entries,
  loading,
  error,
  emptyHint,
  teacherId,
  studentId,
  onDataChanged,
}: {
  entries: TimelineEntry[];
  loading: boolean;
  error: string | null;
  emptyHint: string;
  teacherId: string;
  studentId: string;
  onDataChanged: () => void;
}) {
  if (loading && entries.length === 0) {
    return <p className="muted">正在加载时间线…</p>;
  }

  if (error) {
    return (
      <div className="danger-card danger-card--inline" role="alert">
        <p>时间线加载失败：{error}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="empty-state empty-state--inline">
        <p>{emptyHint}</p>
      </div>
    );
  }

  return (
    <ol className="timeline-list">
      {entries.map((entry) => (
        <li key={`${entry.type}-${entry.id}`} className="timeline-item">
          <div className="timeline-item-head">
            <span className={`timeline-type-badge timeline-type-badge--${entry.type}`}>
              {timelineTypeLabels[entry.type] ?? entry.type}
            </span>
            <time className="timeline-date" dateTime={entry.occurredAt}>
              {formatDate(entry.occurredAt)}
            </time>
            {entry.reviewStatus ? (
              <span className={`review-badge review-badge--${entry.reviewStatus}`}>
                {reviewStatusLabels[entry.reviewStatus] ?? entry.reviewStatus}
              </span>
            ) : null}
          </div>
          <h4 className="timeline-title">{entry.title}</h4>
          {entry.summary ? <p className="timeline-summary">{entry.summary}</p> : null}
          {entry.type === 'assessment' && entry.score !== null ? (
            <div className="timeline-assessment-meta">
              <span className="assessment-score">
                {entry.score}{entry.fullScore !== null ? `/${entry.fullScore}` : ''}
              </span>
              {entry.subject ? <span className="assessment-subject">{entry.subject}</span> : null}
              {entry.examName ? <span className="assessment-exam">{entry.examName}</span> : null}
            </div>
          ) : null}
          {entry.category === 'parent_communication' && entry.communicationDetail ? (
            <CommunicationCard
              detail={entry.communicationDetail}
              recordId={entry.id}
              teacherId={teacherId}
              studentId={studentId}
              onUpdated={onDataChanged}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// ---- 家长沟通卡片（含编辑） ----
function CommunicationCard({
  detail,
  recordId,
  teacherId,
  studentId,
  onUpdated,
}: {
  detail: TimelineCommunicationDetail;
  recordId: string;
  teacherId: string;
  studentId: string;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [direction, setDirection] = useState(detail.direction);
  const [channel, setChannel] = useState(detail.channel ?? '');
  const [parentType, setParentType] = useState(detail.parentType ?? '');
  const [concernsText, setConcernsText] = useState(detail.parentConcerns.join('\n'));
  const [responsesText, setResponsesText] = useState(detail.teacherResponses.join('\n'));
  const [agreementsText, setAgreementsText] = useState(detail.agreements.join('\n'));
  const [followUpsText, setFollowUpsText] = useState(detail.followUps.join('\n'));
  const [nextContactAt, setNextContactAt] = useState(detail.nextContactAtTs ?? '');

  function openEdit() {
    setEditing(true);
    setSaveError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setDirection(detail.direction);
    setChannel(detail.channel ?? '');
    setParentType(detail.parentType ?? '');
    setConcernsText(detail.parentConcerns.join('\n'));
    setResponsesText(detail.teacherResponses.join('\n'));
    setAgreementsText(detail.agreements.join('\n'));
    setFollowUpsText(detail.followUps.join('\n'));
    setNextContactAt(detail.nextContactAtTs ?? '');
    setSaveError(null);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);

    const patch: CommunicationDetailPatch = {
      direction: direction || undefined,
      channel: channel || null,
      parentType: parentType || null,
      parentConcerns: concernsText.split('\n').map((s) => s.trim()).filter(Boolean),
      teacherResponses: responsesText.split('\n').map((s) => s.trim()).filter(Boolean),
      agreements: agreementsText.split('\n').map((s) => s.trim()).filter(Boolean),
      followUps: followUpsText.split('\n').map((s) => s.trim()).filter(Boolean),
      nextContactAt: nextContactAt || null,
    };

    try {
      await updateCommunicationDetail(teacherId, studentId, recordId, patch);
      setEditing(false);
      onUpdated();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  const directionLabel = communicationDirectionLabels[detail.direction] ?? detail.direction;
  const channelLabel = detail.channel
    ? communicationChannelLabels[detail.channel] ?? detail.channel
    : null;
  const parentTypeLabel = detail.parentType
    ? communicationParentTypeLabels[detail.parentType] ?? detail.parentType
    : null;

  return (
    <div className="comm-card">
      <div className="comm-card-head">
        <span className="comm-type-badge">沟通</span>
        <div className="comm-meta-tags">
          <span className="comm-meta-tag">{directionLabel}</span>
          {channelLabel ? <span className="comm-meta-tag">{channelLabel}</span> : null}
          {parentTypeLabel ? <span className="comm-meta-tag comm-meta-tag--muted">{parentTypeLabel}</span> : null}
        </div>
        {!editing ? (
          <button
            type="button"
            className="comm-edit-btn secondary-action secondary-action--sm"
            onClick={openEdit}
            aria-label={`编辑沟通记录 ${recordId}`}
          >
            编辑
          </button>
        ) : null}
      </div>

      {!editing ? (
        <>
          <ModerationFlag flagged={detail.moderationFlagged} reasons={detail.moderationReasons} />
          <CommList label="关注点" items={detail.parentConcerns} />
          <CommList label="回应" items={detail.teacherResponses} />
          <CommList label="共识" items={detail.agreements} />
          <CommList label="待办" items={detail.followUps} />
          {detail.nextContactAtTs ? (
            <p className="comm-next-contact">
              <span className="comm-next-label">下次联系：</span>
              <time dateTime={detail.nextContactAtTs}>{formatDateTime(detail.nextContactAtTs)}</time>
            </p>
          ) : null}
        </>
      ) : (
        <form className="comm-edit-form" onSubmit={handleSave}>
          <div className="comm-edit-row">
            <label htmlFor={`comm-dir-${recordId}`}>方向</label>
            <select
              id={`comm-dir-${recordId}`}
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="">—</option>
              {Object.entries(communicationDirectionLabels).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div className="comm-edit-row">
            <label htmlFor={`comm-channel-${recordId}`}>渠道</label>
            <select
              id={`comm-channel-${recordId}`}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="">—</option>
              {Object.entries(communicationChannelLabels).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div className="comm-edit-row">
            <label htmlFor={`comm-parent-${recordId}`}>家长类型</label>
            <select
              id={`comm-parent-${recordId}`}
              value={parentType}
              onChange={(e) => setParentType(e.target.value)}
            >
              <option value="">—</option>
              {Object.entries(communicationParentTypeLabels).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <CommTextarea
            label="关注点"
            value={concernsText}
            onChange={setConcernsText}
            recordId={recordId}
            field="concerns"
          />
          <CommTextarea
            label="回应"
            value={responsesText}
            onChange={setResponsesText}
            recordId={recordId}
            field="responses"
          />
          <CommTextarea
            label="共识"
            value={agreementsText}
            onChange={setAgreementsText}
            recordId={recordId}
            field="agreements"
          />
          <CommTextarea
            label="待办"
            value={followUpsText}
            onChange={setFollowUpsText}
            recordId={recordId}
            field="followUps"
          />

          <div className="comm-edit-row">
            <label htmlFor={`comm-next-${recordId}`}>下次联系时间</label>
            <input
              id={`comm-next-${recordId}`}
              type="datetime-local"
              value={nextContactAt ? toLocalInputValue(nextContactAt) : ''}
              onChange={(e) => setNextContactAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
            />
          </div>

          {saveError ? (
            <p className="detail-message danger" role="alert">{saveError}</p>
          ) : null}

          <div className="comm-edit-actions">
            <button
              type="submit"
              className="primary-action primary-action--sm"
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="secondary-action secondary-action--sm"
              onClick={cancelEdit}
              disabled={saving}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CommList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="comm-list-group">
      <p className="comm-list-label">{label}</p>
      <ul className="comm-list">
        {items.map((item, i) => (
          <li key={`${label}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function CommTextarea({
  label,
  value,
  onChange,
  recordId,
  field,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  recordId: string;
  field: string;
}) {
  return (
    <div className="comm-edit-textarea-row">
      <label htmlFor={`comm-${field}-${recordId}`}>{label}（每行一条）</label>
      <textarea
        id={`comm-${field}-${recordId}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
      />
    </div>
  );
}

// ---- 成绩列表 ----
function ScoresList({
  entries,
  loading,
  error,
}: {
  entries: TimelineEntry[];
  loading: boolean;
  error: string | null;
}) {
  if (loading && entries.length === 0) {
    return <p className="muted">正在加载成绩…</p>;
  }

  if (error) {
    return (
      <div className="danger-card danger-card--inline" role="alert">
        <p>成绩加载失败：{error}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="empty-state empty-state--inline">
        <p>还没有成绩记录</p>
      </div>
    );
  }

  return (
    <ul className="scores-list">
      {entries.map((entry, index) => {
        // previousScore: 从下一条（时间倒序，下一条是更早的）获取分数
        const previousEntry = entries[index + 1];
        const previousScore = previousEntry?.score;

        return (
          <li key={`${entry.type}-${entry.id}`} className="score-item">
            <div className="score-item-main">
              <span className="score-subject">{entry.subject ?? '—'}</span>
              <span className="score-value">
                {entry.score ?? '—'}{entry.fullScore !== null ? `/${entry.fullScore}` : ''}
              </span>
            </div>
            <div className="score-item-meta">
              <span>{entry.examName ?? '未命名考试'}</span>
              <time dateTime={entry.occurredAt}>{formatDate(entry.occurredAt)}</time>
            </div>
            {previousScore !== null && previousScore !== undefined && entry.score !== null ? (
              <div className={`score-diff ${entry.score > previousScore ? 'score-diff--up' : entry.score < previousScore ? 'score-diff--down' : ''}`}>
                上次 {previousScore}
                {entry.score > previousScore ? ` ↑${entry.score - previousScore}` : entry.score < previousScore ? ` ↓${previousScore - entry.score}` : ' 持平'}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---- 档案记录列表 + 审核 ----
function RecordsList({
  records,
  reviewingId,
  onReview,
}: {
  records: StudentRecordItem[];
  reviewingId: string | null;
  onReview: (recordId: string, status: 'confirmed' | 'rejected') => void;
}) {
  if (records.length === 0) {
    return (
      <div className="empty-state empty-state--inline">
        <p>还没有档案记录</p>
      </div>
    );
  }

  const sorted = [...records].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return (
    <ul className="records-list">
      {sorted.map((record) => (
        <li key={record.id} className="record-item">
          <div className="record-item-head">
            <span className="record-category-badge">
              {recordCategoryLabels[record.category] ?? record.category}
            </span>
            <time className="record-date" dateTime={record.occurredAt}>
              {formatDate(record.occurredAt)}
            </time>
            <span className={`review-badge review-badge--${record.reviewStatus}`}>
              {reviewStatusLabels[record.reviewStatus] ?? record.reviewStatus}
            </span>
          </div>
          <p className="record-summary">{record.summary}</p>
          {record.reviewStatus === 'candidate' ? (
            <div className="record-actions">
              <button
                className="primary-action primary-action--sm"
                type="button"
                onClick={() => onReview(record.id, 'confirmed')}
                disabled={reviewingId === record.id}
                aria-label={`确认记录 ${record.summary}`}
              >
                {reviewingId === record.id ? '处理中…' : '确认'}
              </button>
              <button
                className="secondary-action secondary-action--sm"
                type="button"
                onClick={() => onReview(record.id, 'rejected')}
                disabled={reviewingId === record.id}
                aria-label={`驳回记录 ${record.summary}`}
              >
                驳回
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---- 工具函数 ----
function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function toLocalInputValue(iso: string): string {
  try {
    const date = new Date(iso);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}T${hh}:${mm}`;
  } catch {
    return '';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
