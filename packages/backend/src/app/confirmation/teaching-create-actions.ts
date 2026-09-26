import { Prisma } from '@prisma/client';
import { err, ok, validationError, versionConflict, type Result, type CommonError } from '@teacher-platform/contracts';
import { createSchedulingWebService, type WebFields } from '../../features/scheduling-web/index.js';
import { createMemoService } from '../../features/memos/index.js';
import { createChangelogService } from '../../shared/changelog/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import type { ConfirmableActionExecutor, ConfirmationObjectReference } from './types.js';

export type CreateAction = 'scheduling.create' | 'memos.create';
export type Candidate = (WebFields & { kind: 'schedule' } & ({ recurrence: 'once' } | { recurrence: 'weekly'; weekdays: number[]; endDate?: string }))
  | { kind: 'memo'; title: string; content: string; dueAt?: string };
const invalid = (message: string) => err(validationError(message, 'parameters'));
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const validDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;

/** Resolve a proposal, never a business write, against the database clock. */
function nextWeeklyDay(days: number[], start: string, now?: Date): string | undefined {
  if (!now || !Number.isFinite(now.getTime())) return undefined;
  const date = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  for (let offset = 0; offset <= 7; offset++) {
    const day = date.toISOString().slice(0, 10);
    if (days.includes(weekday(day)) && Date.parse(`${day}T${start}:00+08:00`) > now.getTime()) return day;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return undefined;
}

export function parseCreateCandidate(action: CreateAction, raw: unknown, now?: Date): Result<Candidate, CommonError> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('请补全待确认内容');
  const a = raw as Record<string, unknown>;
  if (action === 'memos.create') {
    if (Object.keys(a).some(key => !['title', 'content', 'dueAt'].includes(key))) return invalid('备忘包含不支持的字段');
    if (!text(a.title, 120) || !text(a.content)) return invalid('请补充备忘标题和内容');
    if (a.dueAt !== undefined) {
      const match = typeof a.dueAt === 'string' ? a.dueAt.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u) : null;
      if (!match || !Number.isFinite(Date.parse(a.dueAt as string))
        || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) return invalid('请确认备忘的具体日期和带时区时间');
    }
    return ok({ kind: 'memo', title: a.title.trim(), content: a.content.trim(), ...(a.dueAt ? { dueAt: a.dueAt as string } : {}) });
  }
  if (Object.keys(a).some(key => !['day', 'start', 'end', 'location', 'participants', 'format', 'note', 'recurrence', 'weekdays', 'endDate'].includes(key))) return invalid('排期包含不支持的字段');
  if (a.recurrence !== 'once' && a.recurrence !== 'weekly') return invalid('排期支持仅一次或每周重复');
  const time = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(v);
  if (!time(a.start) || !time(a.end) || a.end <= a.start) return invalid('请补充同一天内有效的开始和结束时间');
  if (a.day !== undefined && !validDay(a.day)) return invalid('请将周几核对为明确的北京时间日期');
  let days: number[] = [];
  if (a.recurrence === 'weekly') {
    const supplied = a.weekdays ?? (validDay(a.day) ? [weekday(a.day)] : []);
    if (!Array.isArray(supplied) || !supplied.length || !supplied.every(day => Number.isInteger(day) && day >= 1 && day <= 7)
      || new Set(supplied).size !== supplied.length) return invalid('请明确每周上课的星期（周一为1，周日为7）');
    days = [...supplied].sort((a, b) => a - b);
  } else if (a.weekdays !== undefined || a.endDate !== undefined) return invalid('仅一次课程不能带重复规则');
  const day = a.day ?? (a.recurrence === 'weekly' ? nextWeeklyDay(days, a.start, now) : undefined);
  if (!validDay(day)) return invalid('请提供具体日期，或每周星期以准备最近一次上课的确认卡');
  if (a.endDate !== undefined && (!validDay(a.endDate) || a.endDate < day)) return invalid('重复结束日期不得早于开始日期');
  if (a.location !== undefined && (typeof a.location !== 'string' || a.location.length > 200)) return invalid('地点格式无效或过长');
  if (!Array.isArray(a.participants) || !a.participants.every(id => text(id, 128))
      || !a.participants.length || new Set(a.participants).size !== a.participants.length) return invalid('请明确不重复的参与学生名单');
  const format = a.format ?? (a.participants.length === 1 ? '一对一' : '小班');
  if (format !== '一对一' && format !== '小班') return invalid('课程形式必须为一对一或小班');
  if (format === '一对一' ? a.participants.length !== 1 : a.participants.length < 2) return invalid('参与名单与课程形式不一致');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 1000)) return invalid('备注过长或格式无效');
  const base: WebFields & { kind: 'schedule' } = { kind: 'schedule', day, start: a.start, end: a.end, location: typeof a.location === 'string' && a.location.trim() ? a.location.trim() : '待补充',
    participants: [...a.participants].sort(), format, note: typeof a.note === 'string' ? a.note.trim() : '' };
  return a.recurrence === 'weekly'
    ? ok({ ...base, recurrence: 'weekly', weekdays: days, ...(typeof a.endDate === 'string' ? { endDate: a.endDate } : {}) })
    : ok({ ...base, recurrence: 'once' });
}

export function createTeachingCreateExecutors(tx: Prisma.TransactionClient, cipher?: FieldCipher): Record<CreateAction, ConfirmableActionExecutor> {
  function executor(action: CreateAction): ConfirmableActionExecutor {
    return { async execute(input) {
      if (input.target.type !== (action === 'scheduling.create' ? 'Schedule' : 'Memo') || !input.target.id.startsWith('proposal:')) return invalid('创建操作引用不匹配');
      const wrapper = input.parameters as { candidate?: unknown; studentVersions?: Record<string, string> } | null;
      if (!wrapper || Object.keys(wrapper).some(key => !['candidate', 'studentVersions'].includes(key))) return invalid('确认快照无效');
      const parsed = parseCreateCandidate(action, wrapper.candidate); if (!parsed.ok) return parsed;
      const value = parsed.value;
      let id: string;
      let referenceType: ConfirmationObjectReference['type'] = input.target.type;
      if (value.kind === 'schedule') {
        const students = await tx.student.findMany({ where: { teacherId: input.teacherId, id: { in: value.participants } } });
        if (students.length !== value.participants.length || students.some(student => wrapper.studentVersions?.[student.id] !== student.updatedAtTs.toISOString())) return err(versionConflict());
        const scheduling = createSchedulingWebService({ getClient: async () => tx, cipher,
          completionFactory: () => ({ completeSchedule: async () => invalid('创建排期不执行完课或扣课') }) });
        const saved = value.recurrence === 'weekly'
          ? await scheduling.createRule(input.teacherId, { startDate: value.day, weekdays: value.weekdays, endDate: value.endDate,
            start: value.start, end: value.end, participants: value.participants, format: value.format, location: value.location, note: value.note, clientRequestId: input.target.id })
          : await scheduling.saveOnce(input.teacherId, { ...value, clientRequestId: input.target.id });
        if (!saved.ok) return saved;
        const row = value.recurrence === 'weekly'
          ? await tx.recurrenceRule.findFirst({ where: { teacherId: input.teacherId, clientRequestId: input.target.id } })
          : await tx.schedule.findFirst({ where: { teacherId: input.teacherId, clientRequestId: input.target.id } });
        if (!row) return invalid('排期保存回执缺失');
        id = row.id;
        if (value.recurrence === 'weekly') referenceType = 'RecurrenceRule';
      } else {
        const saved = await createMemoService({ prisma: tx, cipher }).createMemo({ teacherId: input.teacherId,
          title: value.title, content: value.content, dueAt: value.dueAt ? new Date(value.dueAt) : undefined, source: 'agent-confirmed' });
        if (!saved.ok) return saved;
        id = saved.value.id;
      }
      const audit = await createChangelogService(tx, cipher).recordChange({ teacherId: input.teacherId,
        module: value.kind === 'schedule' ? 'scheduling' : 'memos', action: 'create', targetType: referenceType,
        targetId: id, before: null, after: { ...value }, source: 'agent-confirmed' });
      if (!audit.ok) return audit;
      return ok({ summary: value.kind === 'schedule' ? value.recurrence === 'weekly' ? '每周重复课程已保存到课表，未扣课时' : '课程已保存到课表，未扣课时' : '备忘已保存到待办', references: [{ type: referenceType, id }] });
    } };
  }
  return { 'scheduling.create': executor('scheduling.create'), 'memos.create': executor('memos.create') };
}
