import { useCallback, useEffect, useRef, useState } from 'react';
import { getStudentTimeline } from '../../api/students';
import type { TimelineCommunicationDetail, TimelineEntry } from '../../api/types';
import { formatDateTime } from '../../shared/date-format';
import './student-timeline.css';

export interface StudentTimelineReadbackProps {
  teacherId: string;
  studentId: string;
  refreshToken?: unknown;
}

const TYPE_LABELS: Record<string, string> = {
  record: '档案记录',
  assessment: '测评',
  lesson: '课程',
  feedback: '家长反馈',
};

const REVIEW_LABELS: Record<string, string> = {
  candidate: '待审核',
  pending: '待处理',
  confirmed: '已确认',
  rejected: '已拒绝',
  superseded: '已被替代',
};

const VISIBILITY_LABELS: Record<string, string> = {
  internal_only: '仅教师可见',
  parent_shareable: '可与家长分享',
  needs_review: '待核对',
};

const CATEGORY_LABELS: Record<string, string> = {
  assessment: '测评',
  lesson_observation: '课堂观察',
  parent_communication: '家长沟通',
  learning_state: '学习状态',
  homework: '作业',
  goal: '目标',
  achievement: '进步与成果',
  concern: '待关注',
  agreement: '约定',
  follow_up: '后续跟进',
  general_note: '一般记录',
};

const LESSON_STATUS_LABELS: Record<string, string> = {
  pending: '待核对出勤',
  attended: '已出勤',
  absent: '缺席',
};

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  reviewed: '已审核',
  sent: '已发送',
  archived: '已归档',
};

const DIRECTION_LABELS: Record<string, string> = {
  inbound: '家长发来',
  outbound: '教师发出',
  two_way: '双向沟通',
};

const CHANNEL_LABELS: Record<string, string> = {
  phone: '电话',
  wechat: '微信',
  offline: '线下',
  other: '其他',
};

const PARENT_TYPE_LABELS: Record<string, string> = {
  normal: '普通沟通',
  scores: '关注成绩',
  sensitive: '需谨慎沟通',
};

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '读取学生时间线失败，请稍后重试。';
}

function label(value: string | null, labels: Record<string, string>): string | null {
  if (!value) return null;
  return labels[value] ?? value;
}

function renderStringList(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  const present = values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return present.length ? present.join('、') : null;
}

function CommunicationDetail({ detail }: { detail: TimelineCommunicationDetail }) {
  const fields: Array<[string, string | null]> = [
    ['方向', label(detail.direction || null, DIRECTION_LABELS)],
    ['渠道', label(detail.channel, CHANNEL_LABELS)],
    ['家长类型', label(detail.parentType, PARENT_TYPE_LABELS)],
    ['家长关注', renderStringList(detail.parentConcerns)],
    ['教师回应', renderStringList(detail.teacherResponses)],
    ['达成约定', renderStringList(detail.agreements)],
    ['后续跟进', renderStringList(detail.followUps)],
    ['下次联系', detail.nextContactAtTs ? formatDateTime(detail.nextContactAtTs) : null],
    ['审核提示', detail.moderationFlagged ? renderStringList(detail.moderationReasons ?? []) ?? '需要关注' : null],
  ];
  const present = fields.filter(([, value]) => value);
  if (!present.length) return null;
  return (
    <dl className="student-timeline-communication" aria-label="沟通明细">
      {present.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function TimelineEntryCard({ entry }: { entry: TimelineEntry }) {
  const metadata: Array<[string, string | null]> = [
    ['类别', label(entry.category, CATEGORY_LABELS)],
    ['审核状态', label(entry.reviewStatus, REVIEW_LABELS)],
    ['可见范围', label(entry.visibility, VISIBILITY_LABELS)],
    ['课程状态', entry.type === 'lesson' ? label(entry.status, LESSON_STATUS_LABELS) : null],
    ['反馈状态', entry.type === 'feedback' ? label(entry.status, FEEDBACK_STATUS_LABELS) : null],
    ['科目', entry.subject],
    ['考试名称', entry.examName],
    ['成绩', entry.score === null ? null : `${entry.score}${entry.fullScore === null ? '' : ` / ${entry.fullScore}`}`],
  ];
  return (
    <li className="student-timeline-entry">
      <div className="student-timeline-entry-heading">
        <div>
          <span className="student-timeline-entry-type">{TYPE_LABELS[entry.type] ?? entry.type}</span>
          <h3>{entry.title}</h3>
        </div>
        <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
      </div>
      {entry.summary && <p className="student-timeline-summary">{entry.summary}</p>}
      {metadata.some(([, value]) => value) && (
        <dl className="student-timeline-metadata">
          {metadata.filter(([, value]) => value).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
      {entry.communicationDetail && <CommunicationDetail detail={entry.communicationDetail} />}
    </li>
  );
}

export function StudentTimelineReadback({ teacherId, studentId, refreshToken }: StudentTimelineReadbackProps) {
  const [data, setData] = useState<{ items: TimelineEntry[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; sequence.current += 1; };
  }, []);

  const reload = useCallback(async (preserveVisibleData = false) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    if (!preserveVisibleData) setData(null);
    try {
      const result = await getStudentTimeline(teacherId, studentId, 200);
      if (!live.current || request !== sequence.current) return false;
      setData(result);
      return true;
    } catch (cause) {
      if (live.current && request === sequence.current) setError(messageOf(cause));
      return false;
    } finally {
      if (live.current && request === sequence.current) setLoading(false);
    }
  }, [teacherId, studentId]);

  useEffect(() => { void reload(); }, [reload, refreshToken]);

  return (
    <section className="student-timeline-readback" aria-label="学生长期时间线">
      <header className="student-timeline-heading">
        <div>
          <p className="student-timeline-eyebrow">正式档案</p>
          <h2>学生时间线</h2>
          <p className="student-timeline-caption">权威记录按发生时间读取，显示最近最多 200 条；时间均为北京时间。</p>
        </div>
        <button type="button" onClick={() => { void reload(Boolean(data)); }} disabled={loading}>
          {loading ? '正在读取…' : '刷新'}
        </button>
      </header>

      {error && (
        <div className="student-timeline-error" role="alert">
          <span>{error}{data ? ' 已保留上次成功读取的数据。' : ''}</span>
          <button type="button" onClick={() => { void reload(Boolean(data)); }} disabled={loading}>重试</button>
        </div>
      )}
      {loading && !data && <p className="student-timeline-state" role="status">正在读取学生时间线…</p>}
      {data && (
        <>
          <p className="student-timeline-count" role="status">显示 {data.items.length} / {data.total} 条（最多显示 200 条）</p>
          {!data.items.length ? <p className="student-timeline-empty">暂无学生时间线记录</p> : (
            <ol className="student-timeline-entries" aria-label="学生时间线记录">
              {data.items.map((entry) => <TimelineEntryCard key={`${entry.type}-${entry.id}`} entry={entry} />)}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
