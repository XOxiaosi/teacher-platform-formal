import { Prisma } from '@prisma/client';
import { err, ok, validationError, versionConflict, type Result, type CommonError } from '@teacher-platform/contracts';
import { createSchedulingWebService, type WebFields } from '../../features/scheduling-web/index.js';
import { createMemoService } from '../../features/memos/index.js';
import { createChangelogService } from '../../shared/changelog/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import type { ConfirmableActionExecutor } from './types.js';

export type CreateAction = 'scheduling.create' | 'memos.create';
export type Candidate = (WebFields & { kind: 'schedule'; recurrence: 'once' })
  | { kind: 'memo'; title: string; content: string; dueAt?: string };
const invalid = (message: string) => err(validationError(message, 'parameters'));
const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
export function parseCreateCandidate(action: CreateAction, raw: unknown): Result<Candidate, CommonError> {
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
  if (Object.keys(a).some(key => !['day', 'start', 'end', 'location', 'participants', 'format', 'note', 'recurrence'].includes(key))) return invalid('排期包含不支持的字段');
  if (a.recurrence !== 'once') return invalid('请明确本次是否仅排一次；每周重复请使用课表的重复安排入口');
  if (typeof a.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(a.day)
      || !Number.isFinite(Date.parse(`${a.day}T00:00:00Z`))
      || new Date(`${a.day}T00:00:00Z`).toISOString().slice(0, 10) !== a.day) return invalid('请将周几核对为明确的北京时间日期');
  const time = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(v);
  if (!time(a.start) || !time(a.end) || a.end <= a.start) return invalid('请补充同一天内有效的开始和结束时间');
  if (!text(a.location, 200)) return invalid('请补充上课地点');
  if (a.format !== '一对一' && a.format !== '小班') return invalid('请明确一对一或小班');
  if (!Array.isArray(a.participants) || !a.participants.every(id => text(id, 128))
      || new Set(a.participants).size !== a.participants.length
      || (a.format === '一对一' ? a.participants.length !== 1 : a.participants.length < 2)) return invalid('参与名单待补充；不会保存空名单小班');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 1000)) return invalid('备注过长或格式无效');
  return ok({ kind: 'schedule', day: a.day, start: a.start, end: a.end, location: a.location.trim(),
    participants: [...a.participants].sort(), format: a.format, note: typeof a.note === 'string' ? a.note.trim() : '', recurrence: 'once' });
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
      if (value.kind === 'schedule') {
        const students = await tx.student.findMany({ where: { teacherId: input.teacherId, id: { in: value.participants } } });
        if (students.length !== value.participants.length || students.some(student => wrapper.studentVersions?.[student.id] !== student.updatedAtTs.toISOString())) return err(versionConflict());
        const scheduling = createSchedulingWebService({ getClient: async () => tx, cipher,
          completionFactory: () => ({ completeSchedule: async () => invalid('创建排期不执行完课或扣课') }) });
        const saved = await scheduling.saveOnce(input.teacherId, { ...value, clientRequestId: input.target.id });
        if (!saved.ok) return saved;
        const row = await tx.schedule.findFirst({ where: { teacherId: input.teacherId, clientRequestId: input.target.id } });
        if (!row) return invalid('排期保存回执缺失');
        id = row.id;
      } else {
        const saved = await createMemoService({ prisma: tx, cipher }).createMemo({ teacherId: input.teacherId,
          title: value.title, content: value.content, dueAt: value.dueAt ? new Date(value.dueAt) : undefined, source: 'agent-confirmed' });
        if (!saved.ok) return saved;
        id = saved.value.id;
      }
      const audit = await createChangelogService(tx, cipher).recordChange({ teacherId: input.teacherId,
        module: value.kind === 'schedule' ? 'scheduling' : 'memos', action: 'create', targetType: input.target.type,
        targetId: id, before: null, after: { ...value }, source: 'agent-confirmed' });
      if (!audit.ok) return audit;
      return ok({ summary: value.kind === 'schedule' ? '课程已保存到课表，未扣课时' : '备忘已保存到待办', references: [{ type: input.target.type, id }] });
    } };
  }
  return { 'scheduling.create': executor('scheduling.create'), 'memos.create': executor('memos.create') };
}
