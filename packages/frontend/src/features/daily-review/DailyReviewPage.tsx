import { FormEvent, useState } from 'react';
import { assembleDailyReview } from '../../api/daily-review';
import type { DailyReviewResult, ScheduleData } from '../../api/types';
import { formatDateTime } from '../../shared/date-format';
import { lessonStatusLabel, scheduleStatusLabel } from '../../shared/display-labels';
import './daily-review.css';

interface DailyReviewPageProps {
  teacherId: string;
}

interface ReviewStats {
  plannedCount: number;
  actualCount: number;
  cancelledCount: number;
}

export function DailyReviewPage({ teacherId }: DailyReviewPageProps) {
  const [date, setDate] = useState('');
  const [review, setReview] = useState<DailyReviewResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date) return;

    setGenerating(true);
    setError(null);
    setReview(null);
    try {
      const result = await assembleDailyReview(teacherId, { date });
      setReview(result);
    } catch (generateError) {
      setError(messageOf(generateError));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <section className="daily-review-page">
      <header className="page-hero">
        <p className="eyebrow">教学复盘</p>
        <h2>每日回顾</h2>
        <p>按日期汇总计划、实际完成与取消情况，快速核对当天教学记录。</p>
      </header>

      <form className="page-card daily-review-form" onSubmit={handleGenerate}>
        <label htmlFor="daily-review-date">回顾日期</label>
        <input id="daily-review-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        <button className="primary-action" type="submit" disabled={generating || !date}>{generating ? '生成中' : '生成回顾'}</button>
      </form>

      {error ? (
        <article className="page-card daily-review-error" role="alert">
          <p className="eyebrow">Error</p>
          <h3>回顾生成失败</h3>
          <p>{error}</p>
        </article>
      ) : null}

      {review ? <DailyReviewResultView result={review} /> : null}
    </section>
  );
}

function DailyReviewResultView({ result }: { result: DailyReviewResult }) {
  const stats = readReviewStats(result.review);

  return (
    <div className="daily-review-result">
      <div className="daily-review-stat-grid">
        <MetricCard label="计划日程" value={stats.plannedCount} />
        <MetricCard label="实际完成" value={stats.actualCount} />
        <MetricCard label="已取消" value={stats.cancelledCount} />
      </div>

      <ScheduleReviewList schedules={result.schedules} />
      <LessonReviewList lessons={result.lessons} />
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric-card daily-review-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ScheduleReviewList({ schedules }: { schedules: ScheduleData[] }) {
  return (
    <article className="page-card daily-review-list-card">
      <h3>日程列表</h3>
      {schedules.length === 0 ? <p className="muted">暂无日程。</p> : (
        <ul className="daily-review-list" aria-label="日程列表">
          {schedules.map((schedule) => (
            <li key={schedule.id}>
              <div>
                <strong>{schedule.title}</strong>
                <span className={`status-badge status-badge--${schedule.status}`}>{scheduleStatusLabel(schedule.status)}</span>
              </div>
              <time dateTime={schedule.scheduledStart}>{formatDateTime(schedule.scheduledStart)}</time>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function LessonReviewList({ lessons }: { lessons: unknown[] }) {
  return (
    <article className="page-card daily-review-list-card">
      <h3>课程记录列表</h3>
      {lessons.length === 0 ? <p className="muted">暂无课程记录。</p> : (
        <ul className="daily-review-list" aria-label="课程记录列表">
          {lessons.map((lesson, index) => {
            const item = normalizeLesson(lesson, index);
            return (
              <li key={item.key}>
                <div>
                  <strong>{item.title}</strong>
                  {item.studentName ? <span>{item.studentName}</span> : null}
                </div>
                {item.status ? <span className={`status-badge status-badge--${item.rawStatus}`}>{item.status}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function readReviewStats(review: Record<string, unknown>): ReviewStats {
  return {
    plannedCount: numberField(review.plannedCount),
    actualCount: numberField(review.actualCount),
    cancelledCount: numberField(review.cancelledCount),
  };
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeLesson(lesson: unknown, index: number) {
  if (!isRecord(lesson)) {
    return { key: `lesson-${index}`, title: String(lesson), studentName: null, status: null, rawStatus: null };
  }

  const id = stringField(lesson.id) ?? `lesson-${index}`;
  const title = stringField(lesson.title) ?? stringField(lesson.summary) ?? stringField(lesson.topic) ?? id;
  const studentName = stringField(lesson.studentName) ?? stringField(lesson.studentId);
  const rawStatus = stringField(lesson.status);
  const status = rawStatus ? lessonStatusLabel(rawStatus) : null;

  return { key: id, title, studentName, status, rawStatus };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
