import type { WechatFeedback } from './wechat-feedback';
import { createDemoWechatFeedbacks } from './wechat-feedback';

export type Student = { id: string; name: string; grade: string; balance: number; notes: string[] };
export type LessonAttendance = { lessonId: string; studentId: string; status: 'pending' | 'attended' | 'absent'; updatedAt: string };
export type Schedule = {
  createdAt?: string; updatedAt?: string; version?: string;
  id: string; day: string; start: string; end: string; location: string;
  participants: string[]; format: '一对一' | '小班'; note: string; status: '已排期' | '已完成' | '已取消';
  /** A stored exception or materialized history for a recurring occurrence. */
  recurrenceRuleId?: string; recurrenceDay?: string;
  attendance?: LessonAttendance[];
};
export type RecurrenceRule = {
  updatedAt?: string; version?: string;
  id: string; startDate: string; weekdays: number[]; endDate?: string; enabled: boolean;
  start: string; end: string; location: string; participants: string[]; format: '一对一' | '小班'; note: string;
};
export type Payment = { id: string; studentId: string; amount: number; lessons: number; date: string };
export type Memo = { id: string; text: string; done: boolean };
export type Feedback = { id: string; studentId: string; title: string; content: string; updatedAt: string; status?: '草稿' | '已核对' | '已发送' };
export type CompletionRecord = { id: string; scheduleId: string; studentId: string; date: string; before: number; after: number };
export type ScheduleRevision = { id: string; scheduleId: string; changedAt: string; before: Schedule; after: Schedule };
export type DemoData = {
  businessDate?: string;
  students: Student[]; schedules: Schedule[]; recurrenceRules: RecurrenceRule[]; payments: Payment[];
  memos: Memo[]; feedbacks: Feedback[]; wechatFeedbacks?: WechatFeedback[]; completionRecords: CompletionRecord[]; scheduleRevisions?: ScheduleRevision[]; studioName: string;
  settings?: { modelChoice?: string; wechatChannel?: string };
};

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const take = (name: string) => parts.find((part) => part.type === name)?.value || '';
  return `${take('year')}-${take('month')}-${take('day')}`;
}

export const today = shanghaiDate();
function dayAfter(days: number) {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createDemoData(): DemoData {
  return {
    studioName: '小思教师工作室',
    students: [
      { id: 's1', name: '李雨桐', grade: '初三', balance: 6, notes: ['今天已查看学习记录'] },
      { id: 's2', name: '王浩然', grade: '初二', balance: 2, notes: ['课时余额较低，请留意'] },
      { id: 's3', name: '张思远', grade: '初三', balance: 8, notes: [] },
      { id: 's4', name: '陈乐言', grade: '初一', balance: 4, notes: [] },
    ],
    schedules: [
      { id: 'sc1', day: today, start: '09:00', end: '10:30', location: '工作室 A', participants: ['s1'], format: '一对一', note: '确认到场', status: '已完成' },
      { id: 'sc2', day: today, start: '14:00', end: '15:30', location: '工作室 B', participants: ['s2', 's3'], format: '小班', note: '课前小测', status: '已排期' },
      { id: 'sc3', day: today, start: '19:00', end: '20:30', location: '线上会议室', participants: ['s4'], format: '一对一', note: '确认线上设备', status: '已排期' },
      { id: 'sc4', day: dayAfter(2), start: '10:00', end: '11:30', location: '工作室 A', participants: ['s1'], format: '一对一', note: '确认到场', status: '已排期' },
    ],
    recurrenceRules: [
      { id: 'rr1', startDate: dayAfter(1), weekdays: [1, 3], enabled: true, start: '16:30', end: '18:00', location: '工作室 B', participants: ['s2', 's3'], format: '小班', note: '课前确认到场' },
    ],
    payments: [{ id: 'p1', studentId: 's1', amount: 4800, lessons: 16, date: dayAfter(-21) }, { id: 'p2', studentId: 's3', amount: 3000, lessons: 12, date: dayAfter(-11) }],
    memos: [{ id: 'm1', text: '确认本周空闲时段', done: false }, { id: 'm2', text: '整理课堂记录', done: false }],
    feedbacks: [{ id: 'f1', studentId: 's1', title: '本周反馈草稿', content: '本周课堂情况：\n待补充\n\n后续安排：\n待补充', updatedAt: today }],
    wechatFeedbacks: createDemoWechatFeedbacks(today),
    completionRecords: [{ id: 'cr1', scheduleId: 'sc1', studentId: 's1', date: today, before: 7, after: 6 }],
    scheduleRevisions: [],
  };
}
