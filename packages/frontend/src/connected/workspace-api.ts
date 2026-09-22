import { apiRequest } from '../api/client';
import { me } from '../api/auth';
import type { LessonBalance, ListResult, MemoData, ParentFeedbackData, PaymentData, StudentData, StudentRecordItem } from '../api/types';
import type { DemoData } from '../preview/data';

export type ScheduleState = Pick<DemoData, 'schedules' | 'recurrenceRules' | 'scheduleRevisions' | 'completionRecords'>;
type Preferences = { studioName: string; modelChoice: string; wechatChannel: string; updatedAtTs: string };
export type WorkspaceState = { businessDate: string; preferences: Preferences | null; memos: MemoData[] };
export type WorkspaceSnapshot = { data: DemoData; studentVersions: Record<string, string>; feedbackVersions: Record<string, string>; memoVersions: Record<string, string>; preferenceVersion: string | null };
export const workspaceCommand = (operation: string, body: unknown) => apiRequest(`/workspace-web/${operation}`, { method: 'POST', body });
export const schedulingCommand = (body: unknown) => apiRequest('/scheduling-web/commands', { method: 'POST', body });

export function businessDate(value: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (key: string) => parts.find((part) => part.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Fetch every page; a successful first page must not masquerade as the whole workspace. */
export async function listAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const result = await apiRequest<ListResult<T>>(`${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`, {});
    items.push(...result.items);
    if (items.length >= result.total) return items;
    if (!result.items.length) throw new Error('资料未加载完整，请重试。');
  }
  throw new Error('资料数量超过本次加载上限，请联系维护人员。');
}

export async function loadWorkspace(expectedTeacherId: string): Promise<WorkspaceSnapshot> {
  const identityError = () => Object.assign(new Error('登录账号已变化，请重新登录。'), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  const assertIdentity = async () => { if ((await me())?.id !== expectedTeacherId) throw identityError(); };
  await assertIdentity();
  const [students, payments, feedbacks, workspace, schedules] = await Promise.all([
    listAll<StudentData>('/students'), listAll<PaymentData>('/payments'), listAll<ParentFeedbackData>('/feedback'),
    apiRequest<WorkspaceState>('/workspace-web/state', {}), apiRequest<ScheduleState>('/scheduling-web/state', {}),
  ]);
  const adapted: DemoData['students'] = [];
  if ([...students, ...payments, ...feedbacks, ...workspace.memos].some((item) => item.teacherId !== expectedTeacherId)) throw identityError();
  // Limit fan-out so a teacher with many students does not saturate the DB pool.
  for (let offset = 0; offset < students.length; offset += 5) {
    adapted.push(...await Promise.all(students.slice(offset, offset + 5).map(async (student) => {
      const path = `/students/${encodeURIComponent(student.id)}`;
      const [balance, records] = await Promise.all([apiRequest<LessonBalance>(`${path}/balance`, {}), listAll<StudentRecordItem>(`${path}/records`)]);
      return { id: student.id, name: student.name, grade: student.grade, balance: balance.remaining, notes: records.filter((record) => record.reviewStatus === 'confirmed').map((record) => record.summary || '').filter(Boolean) };
    })));
  }
  await assertIdentity();
  return {
    data: { ...schedules, students: adapted, businessDate: workspace.businessDate,
      payments: payments.map((item) => ({ id: item.id, studentId: item.studentId, amount: item.amount, lessons: item.lessonCount, date: businessDate(item.paidAt) })),
      feedbacks: feedbacks.filter((item) => item.status !== 'archived').map((item) => ({ id: item.id, studentId: item.studentId, title: item.title, content: item.content, updatedAt: businessDate(item.updatedAt), status: item.status === 'sent' ? '已发送' : item.status === 'reviewed' ? '已核对' : '草稿' })),
      memos: workspace.memos.filter((memo) => memo.status !== 'archived').map((memo) => ({ id: memo.id, text: memo.content, done: memo.status === 'done' })),
      studioName: workspace.preferences?.studioName || '教师工作室', settings: { modelChoice: workspace.preferences?.modelChoice || 'default', wechatChannel: workspace.preferences?.wechatChannel || 'personal' },
    },
    studentVersions: Object.fromEntries(students.map((item) => [item.id, item.updatedAt])),
    feedbackVersions: Object.fromEntries(feedbacks.map((item) => [item.id, item.updatedAt])),
    memoVersions: Object.fromEntries(workspace.memos.map((item) => [item.id, item.updatedAt])),
    preferenceVersion: workspace.preferences?.updatedAtTs || null,
  };
}
