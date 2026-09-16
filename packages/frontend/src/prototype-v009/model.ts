import type { Dispatch, SetStateAction } from 'react';

export type Student = { id: string; name: string; grade: string; balance: number };
export type Course = { id: string; day: string; start: string; end: string; studentIds: string[]; location: string; format: '一对一' | '小班'; note: string; status: 'scheduled' | 'completed' | 'cancelled'; ruleId?: string; enteredAt?: string };
export type LessonEntry = { id: string; courseId: string; studentId: string; attended: boolean; amount: number; before: number; after: number; day: string };
export type Candidate = { id: string; studentId: string; occurredOn: string; courseId?: string; source: string; speaker: string; kind: string; text: string; uncertainty?: string; status: 'pending' | 'confirmed' | 'rejected'; share: boolean };
export type Feedback = { studentId: string; occurredOn: string; courseId?: string; text: string; status: 'draft' | 'reviewed'; sourceIds: string[] };
export type FeedbackDraft = Pick<Feedback, 'text' | 'sourceIds'>;
export type Studio = { students: Student[]; courses: Course[]; ledger: LessonEntry[]; candidates: Candidate[]; feedback: Feedback | null; feedbacks: Record<string, Feedback> };
export type StudioProps = { data: Studio; setData: Dispatch<SetStateAction<Studio>>; notify: (text: string) => void; localDrafts?: Record<string, FeedbackDraft>; setLocalDrafts?: Dispatch<SetStateAction<Record<string, FeedbackDraft>>> };
export type ScheduleRequest = { key: number; mode: 'add' | 'backfill' | 'complete'; courseId?: string };
export const DEMO_DAY = '2026-09-14';
export const sourceText = '9 月 14 日课后记录：我观察到小雨今天能独立完成 3 道错题中的 2 道。妈妈说这周睡觉较晚，早上起床困难。小雨说：“最后一道我知道第一步，但后面就不知道了。”我计划下次让她先口述解题步骤，暂时还没有实施。';
export function createStudio(): Studio {
  return {
    students: [{ id: 's1', name: '林小雨', grade: '五年级', balance: 12 }, { id: 's2', name: '陈一诺', grade: '五年级', balance: 8 }, { id: 's3', name: '周子安', grade: '六年级', balance: 6 }],
    courses: [
      { id: 'c1', day: DEMO_DAY, start: '14:00', end: '16:00', studentIds: ['s1'], location: '教室 A', format: '一对一', note: '先确认错题是否订正', status: 'scheduled' },
      { id: 'c2', day: DEMO_DAY, start: '18:00', end: '20:00', studentIds: ['s2','s3'], location: '教室 B', format: '小班', note: '', status: 'scheduled' },
      { id: 'c3', day: '2026-09-16', start: '14:00', end: '15:30', studentIds: ['s1'], location: '线上', format: '一对一', note: '', status: 'scheduled' },
    ], ledger: [],
    candidates: [
      { id: 'r1', studentId: 's1', occurredOn: DEMO_DAY, courseId: 'c1', source: sourceText, speaker: '教师观察', kind: '学习情况', text: '本次能独立完成 3 道错题中的 2 道。', status: 'pending', share: true },
      { id: 'r2', studentId: 's1', occurredOn: DEMO_DAY, courseId: 'c1', source: sourceText, speaker: '家长反馈', kind: '生活状态', text: '妈妈反映这周睡觉较晚，早上起床困难。', uncertainty: '具体日期与原因未提供；不能认定为学习困难的原因。', status: 'pending', share: false },
      { id: 'r3', studentId: 's1', occurredOn: DEMO_DAY, courseId: 'c1', source: sourceText, speaker: '学生自述', kind: '学习情况', text: '小雨说最后一道题知道第一步，后续步骤还不清楚。', status: 'pending', share: true },
      { id: 'r4', studentId: 's1', occurredOn: DEMO_DAY, courseId: 'c1', source: sourceText, speaker: '教师方案', kind: '下一步计划', text: '计划下次请小雨先口述解题步骤，尚未实施。', uncertainty: '措施尚未实施，没有后续反应或效果记录。', status: 'pending', share: true },
    ], feedback: null, feedbacks: {},
  };
}
export function courseObject(course: Course, students: Student[]) { return course.studentIds.length > 1 ? `小班 · ${course.studentIds.length} 人` : students.find(s => s.id === course.studentIds[0])?.name || '待补充'; }
