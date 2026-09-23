import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { err, internalError, notFound, ok, validationError, versionConflict, type CommonError, type Result } from '@teacher-platform/contracts';
import { createFieldCipherFromEnv, decryptFieldValue, encryptFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { hasLessonOccurrenceConflict } from '../../shared/lesson-occurrence-conflict/index.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type WebFormat = '一对一' | '小班';
export type WebStatus = '已排期' | '已完成' | '已取消';

export interface WebSchedule {
  id: string; day: string; start: string; end: string; location: string;
  participants: string[]; format: WebFormat; note: string; status: WebStatus;
  recurrenceRuleId?: string; recurrenceDay?: string; updatedAt: string; version: string;
}
export interface WebRule {
  id: string; startDate: string; weekdays: number[]; endDate?: string; enabled: boolean;
  start: string; end: string; location: string; participants: string[]; format: WebFormat; note: string; updatedAt: string; version: string;
}
export interface WebRevision { id: string; scheduleId: string; changedAt: string; before: WebSchedule; after: WebSchedule; }
export interface WebCompletionRecord { id: string; scheduleId: string; studentId: string; date: string; before: number; after: number; }
export interface SchedulingWebState { schedules: WebSchedule[]; recurrenceRules: WebRule[]; scheduleRevisions: WebRevision[]; completionRecords: WebCompletionRecord[]; refreshedAt: string; }
export interface WebFields { day: string; start: string; end: string; location: string; participants: string[]; format: WebFormat; note?: string; }
export interface WebRuleInput extends Omit<WebFields, 'day'> { startDate: string; weekdays: number[]; endDate?: string; enabled?: boolean; }

export interface SchedulingWebService {
  state(teacherId: string): Promise<Result<SchedulingWebState, CommonError>>;
  saveOnce(teacherId: string, input: WebFields & { clientRequestId: string }): Promise<Result<SchedulingWebState, CommonError>>;
  saveOccurrence(teacherId: string, occurrenceId: string, input: WebFields & { clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  createRule(teacherId: string, input: WebRuleInput & { clientRequestId: string }): Promise<Result<SchedulingWebState, CommonError>>;
  replaceRuleFrom(teacherId: string, ruleId: string, input: { fromDate: string; clientRequestId: string; rule: WebRuleInput; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  endRule(teacherId: string, ruleId: string, input: { fromDate: string; clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  setRuleEnabled(teacherId: string, ruleId: string, input: { enabled: boolean; clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  cancel(teacherId: string, occurrenceId: string, input: { clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  restore(teacherId: string, occurrenceId: string, input: { clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  complete(teacherId: string, occurrenceId: string, input: { clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
  editCompleted(teacherId: string, occurrenceId: string, input: WebFields & { clientRequestId: string; expectedUpdatedAt?: string }): Promise<Result<SchedulingWebState, CommonError>>;
}

export interface SchedulingWebCompletionFactoryOptions {
  getClient: () => Promise<Db>;
  cipher?: FieldCipher;
}
export interface SchedulingWebCompletionService {
  completeSchedule(input: { teacherId: string; scheduleId: string }): Promise<Result<unknown, CommonError>>;
}
export interface SchedulingWebServiceOptions {
  getClient: () => Promise<Db>;
  cipher?: FieldCipher;
  completionFactory: (options: SchedulingWebCompletionFactoryOptions) => SchedulingWebCompletionService;
}

const ruleInclude = { participants: { orderBy: { createdAtTs: 'asc' } } } as const;
const scheduleInclude = { participants: { orderBy: { createdAtTs: 'asc' } } } as const;
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit' });

export function createSchedulingWebService(options: SchedulingWebServiceOptions): SchedulingWebService {
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  function completionFor(tx: Db): SchedulingWebCompletionService {
    return options.completionFactory({
      // The scheduling command already owns the serializable transaction, so
      // the ordinary completion path runs in this exact transaction. B02
      // keeps lesson-ledger charging and completion snapshots out of it.
      getClient: async () => tx,
      cipher,
    });
  }

  async function client() { return options.getClient(); }
  class Rollback<T> extends Error { constructor(readonly result: Result<T, CommonError>) { super('scheduling-web rollback'); } }
  async function transact<T>(teacherId: string, work: (tx: Db) => Promise<Result<T, CommonError>>): Promise<Result<T, CommonError>> {
    const prisma = await client();
    const execute = async (tx: Db) => { const result = await work(tx); if (!result.ok) throw new Rollback(result); return result; };
    const opensTransaction = '$transaction' in prisma && typeof (prisma as PrismaClient).$transaction === 'function';
    try {
      if (opensTransaction) {
        return await (prisma as PrismaClient).$transaction(execute, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
      return execute(prisma);
    } catch (caught) {
      if (caught instanceof Rollback) {
        if (!opensTransaction) throw caught;
        return caught.result;
      }
      if (caught instanceof Prisma.PrismaClientKnownRequestError && (caught.code === 'P2002' || caught.code === 'P2034')) return err(versionConflict());
      return err(internalError('排课保存失败'));
    }
  }
  async function mutate(teacherId: string, clientRequestId: string, kind: string, payload: unknown, work: (tx: Db) => Promise<Result<SchedulingWebState, CommonError>>) {
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex');
    return transact(teacherId, async (tx) => {
      const previous = await tx.schedulingWebMutationReceipt.findFirst({ where: { teacherId, clientRequestId } });
      if (previous) return previous.fingerprint === fingerprint ? buildState(tx, teacherId) : err(versionConflict());
      const result = await work(tx); if (!result.ok) return result;
      await tx.schedulingWebMutationReceipt.create({ data: { teacherId, clientRequestId, fingerprint } });
      return result;
    });
  }

  async function buildState(prisma: Db, teacherId: string): Promise<Result<SchedulingWebState, CommonError>> {
    const [schedules, rules, revisions, completionRecords, now] = await Promise.all([
      prisma.schedule.findMany({ where: { teacherId, type: 'lesson', classFormat: { not: null } }, include: scheduleInclude, orderBy: [{ scheduledStartTs: 'asc' }, { id: 'asc' }] }),
      prisma.recurrenceRule.findMany({ where: { teacherId }, include: ruleInclude, orderBy: { createdAtTs: 'asc' } }),
      prisma.scheduleRevision.findMany({ where: { teacherId }, orderBy: { createdAtTs: 'asc' } }),
      prisma.scheduleCompletionSnapshot.findMany({ where: { teacherId }, orderBy: { createdAtTs: 'asc' } }),
      createDatabaseTrustedClock(prisma).now(),
    ]);
    if (!now.ok) return err(now.error);
    try {
      return ok({
        schedules: schedules.map((row) => toSchedule(row, cipher)),
        recurrenceRules: rules.map((row) => toRule(row, cipher)),
        scheduleRevisions: revisions.map((row) => ({
          id: row.id, scheduleId: row.scheduleId, changedAt: row.createdAtTs.toISOString(),
          before: decryptSnapshot(row.beforeCiphertext, cipher), after: decryptSnapshot(row.afterCiphertext, cipher),
        })),
        completionRecords: completionRecords.map((row) => ({ id: row.id, scheduleId: row.scheduleId, studentId: row.studentId, date: localDay(row.createdAtTs), before: row.balanceBefore, after: row.balanceAfter })),
        refreshedAt: now.value.toISOString(),
      });
    } catch {
      return err(internalError('排课数据无法安全读取'));
    }
  }
  async function state(teacherId: string) { return buildState(await client(), teacherId); }

  async function validateFields(prisma: Db, teacherId: string, value: WebFields): Promise<Result<void, CommonError>> {
    if (!validDate(value.day)) return err(validationError('日期格式无效', 'day'));
    if (!validTime(value.start) || !validTime(value.end) || value.end <= value.start) return err(validationError('结束时间必须晚于开始时间', 'end'));
    if (!value.location?.trim()) return err(validationError('地点不能为空', 'location'));
    const ids = unique(value.participants);
    if (value.format !== '一对一' && value.format !== '小班') return err(validationError('课程形式无效', 'format'));
    if ((value.format === '一对一' && ids.length !== 1) || (value.format === '小班' && ids.length < 2)) return err(validationError('参与人数量不符合课程形式', 'participants'));
    const owned = await prisma.student.count({ where: { teacherId, id: { in: ids } } });
    return owned === ids.length ? ok(undefined) : err(notFound('学生不存在'));
  }
  async function validateRule(prisma: Db, teacherId: string, value: WebRuleInput): Promise<Result<void, CommonError>> {
    const fields = await validateFields(prisma, teacherId, { ...value, day: value.startDate });
    if (!fields.ok) return fields;
    if (!validDate(value.startDate) || (value.endDate && (!validDate(value.endDate) || value.endDate < value.startDate))) return err(validationError('重复起止日期无效', 'startDate'));
    const weekdays = unique(value.weekdays);
    return weekdays.length > 0 && weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      ? ok(undefined) : err(validationError('每周重复至少选择一个星期', 'weekdays'));
  }
  async function conflictForOccurrence(prisma: Db, teacherId: string, value: WebFields, ignoreScheduleId?: string, ignoreRuleOccurrence?: { ruleId: string; day: string }): Promise<boolean> {
    const start = instant(value.day, value.start); const end = instant(value.day, value.end);
    return hasLessonOccurrenceConflict(prisma, teacherId, { start, end }, {
      ignoreScheduleId,
      ignoreRuleOccurrence,
    });
  }
  async function conflictForRule(prisma: Db, teacherId: string, value: WebRuleInput, ignoreRuleId?: string): Promise<boolean> {
    const rules = await prisma.recurrenceRule.findMany({ where: { teacherId, enabled: true, ...(ignoreRuleId ? { id: { not: ignoreRuleId } } : {}) } });
    if (rules.some((rule) => overlaps(value.start, value.end, rule.startTime, rule.endTime) && recurringIntersects(value, rule))) return true;
    const direct = await prisma.schedule.findMany({ where: { teacherId, type: 'lesson', status: { in: ['planned', 'extra'] }, ...(ignoreRuleId ? { OR: [{ recurrenceRuleId: null }, { recurrenceRuleId: { not: ignoreRuleId } }] } : {}) } });
    return direct.some((row) => occurs(value, localDay(row.scheduledStartTs)) && overlaps(value.start, value.end, localTime(row.scheduledStartTs), localTime(row.scheduledEndTs)));
  }
  async function insertSchedule(prisma: Db, teacherId: string, value: WebFields, extra: { recurrenceRuleId?: string; recurrenceDay?: string; clientRequestId?: string } = {}) {
    return prisma.schedule.create({ data: {
      teacherId, studentId: unique(value.participants)[0] ?? null, type: 'lesson', title: '',
      locationCiphertext: encryptFieldValue(cipher, value.location.trim()), classFormat: formatDb(value.format),
      operationalNoteCiphertext: value.note?.trim() ? encryptFieldValue(cipher, value.note.trim()) : null,
      clientRequestId: extra.clientRequestId ?? null, scheduledStartTs: instant(value.day, value.start), scheduledEndTs: instant(value.day, value.end),
      recurrenceRuleId: extra.recurrenceRuleId ?? null, recurrenceDay: extra.recurrenceDay ? dateOnly(extra.recurrenceDay) : null,
      participants: { create: unique(value.participants).map((studentId) => ({ teacherId, studentId })) },
    }, include: scheduleInclude });
  }
  async function resolveOccurrence(prisma: Db, teacherId: string, occurrenceId: string): Promise<Result<{ row: any; rule?: any; projected?: WebFields }, CommonError>> {
    const stored = await prisma.schedule.findFirst({ where: { id: occurrenceId, teacherId }, include: scheduleInclude });
    if (stored) return ok({ row: stored });
    const parsed = synthetic(occurrenceId);
    if (!parsed) return err(notFound('排期不存在'));
    const rule = await prisma.recurrenceRule.findFirst({ where: { id: parsed.ruleId, teacherId }, include: ruleInclude });
    if (!rule || !rule.enabled || !occurs(rule, parsed.day)) return err(notFound('排期不存在'));
    return ok({ row: null, rule, projected: ruleFields(rule, cipher, parsed.day) });
  }
  async function materialize(prisma: Db, teacherId: string, occurrenceId: string, status?: 'planned' | 'cancelled') {
    const parsed = synthetic(occurrenceId); if (!parsed) return null;
    const rule = await prisma.recurrenceRule.findFirst({ where: { id: parsed.ruleId, teacherId }, include: ruleInclude });
    if (!rule || !rule.enabled || !occurs(rule, parsed.day)) return null;
    const fields = ruleFields(rule, cipher, parsed.day);
    const existing = await prisma.schedule.findFirst({ where: { teacherId, recurrenceRuleId: rule.id, recurrenceDay: dateOnly(parsed.day) }, include: scheduleInclude });
    if (existing) return existing;
    const created = await insertSchedule(prisma, teacherId, fields, { recurrenceRuleId: rule.id, recurrenceDay: parsed.day });
    return status ? prisma.schedule.update({ where: { id: created.id }, data: { status }, include: scheduleInclude }) : created;
  }

  return {
    state,
    async saveOnce(teacherId, input) {
      return mutate(teacherId, input.clientRequestId, 'save-schedule-once', input, async (tx) => {
        const valid = await validateFields(tx, teacherId, input); if (!valid.ok) return valid;
        if (await conflictForOccurrence(tx, teacherId, input)) return err(validationError('该时段与现有排期冲突', 'time'));
        const replay = await tx.schedule.findFirst({ where: { teacherId, clientRequestId: input.clientRequestId }, include: scheduleInclude });
        if (!replay) await insertSchedule(tx, teacherId, input, { clientRequestId: input.clientRequestId });
        return buildState(tx, teacherId);
      });
    },
    async saveOccurrence(teacherId, occurrenceId, input) {
      return mutate(teacherId, input.clientRequestId, 'save-schedule-occurrence', { occurrenceId, input }, async (tx) => {
        const valid = await validateFields(tx, teacherId, input); if (!valid.ok) return valid;
        const found = await resolveOccurrence(tx, teacherId, occurrenceId); if (!found.ok) return found;
        if (!matchesVersion(found.value.row ?? found.value.rule, input.expectedUpdatedAt)) return err(versionConflict());
        if (found.value.row?.status === 'completed') return err(validationError('已完成课程请使用修订接口', 'occurrenceId'));
        const ignore = found.value.row?.id;
        const original = found.value.row?.recurrenceRuleId && found.value.row.recurrenceDay
          ? { ruleId: found.value.row.recurrenceRuleId, day: localDay(found.value.row.recurrenceDay) }
          : synthetic(occurrenceId);
        if (await conflictForOccurrence(tx, teacherId, input, ignore, original)) return err(validationError('该时段与现有排期冲突', 'time'));
        if (found.value.row) {
          await tx.schedule.update({ where: { id: found.value.row.id }, data: scheduleUpdate(input, cipher, teacherId), include: scheduleInclude });
        } else {
          const parsed = synthetic(occurrenceId)!;
          await insertSchedule(tx, teacherId, input, { recurrenceRuleId: parsed.ruleId, recurrenceDay: parsed.day, clientRequestId: input.clientRequestId });
        }
        return buildState(tx, teacherId);
      });
    },
    async createRule(teacherId, input) {
      return mutate(teacherId, input.clientRequestId, 'save-rule', input, async (tx) => {
        const valid = await validateRule(tx, teacherId, input); if (!valid.ok) return valid;
        const replay = await tx.recurrenceRule.findFirst({ where: { teacherId, clientRequestId: input.clientRequestId }, include: ruleInclude });
        if (!replay) {
          if (input.enabled !== false && await conflictForRule(tx, teacherId, input)) return err(validationError('重复安排与现有排期冲突', 'weekdays'));
          await tx.recurrenceRule.create({ data: ruleCreate(teacherId, input, cipher, input.clientRequestId), include: ruleInclude });
        }
        return buildState(tx, teacherId);
      });
    },
    async replaceRuleFrom(teacherId, ruleId, input) {
      return mutate(teacherId, input.clientRequestId, 'replace-rule', { ruleId, input }, async (tx) => {
        if (!validDate(input.fromDate)) return err(validationError('fromDate 无效', 'fromDate'));
        const old = await tx.recurrenceRule.findFirst({ where: { id: ruleId, teacherId }, include: ruleInclude }); if (!old) return err(notFound('重复规则不存在'));
        if (!matchesVersion(old, input.expectedUpdatedAt)) return err(versionConflict());
        const valid = await validateRule(tx, teacherId, input.rule); if (!valid.ok) return valid;
        // A replacement begins on its requested cutover date.  Letting the new
        // rule start anywhere else either creates an overlapping history or
        // silently leaves a gap before the cutover.
        if (input.rule.startDate !== input.fromDate) return err(validationError('替换规则开始日期必须等于替换日期', 'rule.startDate'));
        if (input.fromDate < localDay(old.startDate)) return err(validationError('替换日期不能早于原规则开始日期', 'fromDate'));
        if (input.rule.enabled !== false && await conflictForRule(tx, teacherId, input.rule, ruleId)) return err(validationError('重复安排与现有排期冲突', 'weekdays'));
        const cutoff = addDays(input.fromDate, -1);
        const oldEnd = old.endDate ? localDay(old.endDate) : undefined;
        await tx.recurrenceRule.update({ where: { id: old.id }, data: { endDate: dateOnly(oldEnd && oldEnd < cutoff ? oldEnd : cutoff) } });
        const replacement = await tx.recurrenceRule.create({ data: ruleCreate(teacherId, input.rule, cipher, input.clientRequestId) });
        // Keep explicit future exceptions under their replacement rule without
        // touching completed/cancelled historical rows or their ledger links.
        await tx.schedule.updateMany({ where: { teacherId, recurrenceRuleId: old.id, recurrenceDay: { gte: dateOnly(input.fromDate) }, status: { in: ['planned', 'extra'] } }, data: { recurrenceRuleId: replacement.id } });
        return buildState(tx, teacherId);
      });
    },
    async endRule(teacherId, ruleId, input) {
      return mutate(teacherId, input.clientRequestId, 'end-rule', { ruleId, input }, async (tx) => {
        if (!validDate(input.fromDate)) return err(validationError('fromDate 无效', 'fromDate'));
        const rule = await tx.recurrenceRule.findFirst({ where: { id: ruleId, teacherId } }); if (!rule) return err(notFound('重复规则不存在'));
        if (!matchesVersion(rule, input.expectedUpdatedAt)) return err(versionConflict());
        const cutoff = addDays(input.fromDate, -1); const oldEnd = rule.endDate ? localDay(rule.endDate) : undefined;
        await tx.recurrenceRule.update({ where: { id: rule.id }, data: { endDate: dateOnly(oldEnd && oldEnd < cutoff ? oldEnd : cutoff) } });
        return buildState(tx, teacherId);
      });
    },
    async setRuleEnabled(teacherId, ruleId, input) {
      return mutate(teacherId, input.clientRequestId, 'set-rule-enabled', { ruleId, input }, async (tx) => {
        const rule = await tx.recurrenceRule.findFirst({ where: { id: ruleId, teacherId }, include: ruleInclude }); if (!rule) return err(notFound('重复规则不存在'));
        if (!matchesVersion(rule, input.expectedUpdatedAt)) return err(versionConflict());
        if (input.enabled && await conflictForRule(tx, teacherId, ruleToInput(rule, cipher), rule.id)) return err(validationError('恢复重复安排会与现有排期冲突', 'enabled'));
        await tx.recurrenceRule.update({ where: { id: rule.id }, data: { enabled: input.enabled } });
        return buildState(tx, teacherId);
      });
    },
    async cancel(teacherId, occurrenceId, input) {
      return mutate(teacherId, input.clientRequestId, 'cancel', { occurrenceId, input }, async (tx) => {
        const found = await resolveOccurrence(tx, teacherId, occurrenceId); if (!found.ok) return found;
        if (!matchesVersion(found.value.row ?? found.value.rule, input.expectedUpdatedAt)) return err(versionConflict());
        if (found.value.row?.status === 'completed') return err(validationError('已完成课程不能取消', 'occurrenceId'));
        const row = found.value.row ?? await materialize(tx, teacherId, occurrenceId, 'cancelled');
        if (!row) return err(notFound('排期不存在'));
        if (row.status === 'planned' || row.status === 'extra') await tx.schedule.update({ where: { id: row.id }, data: { status: 'cancelled' } });
        return buildState(tx, teacherId);
      });
    },
    async restore(teacherId, occurrenceId, input) {
      return mutate(teacherId, input.clientRequestId, 'restore', { occurrenceId, input }, async (tx) => {
        const found = await resolveOccurrence(tx, teacherId, occurrenceId); if (!found.ok || !found.value.row) return found.ok ? err(notFound('已取消排期不存在')) : found;
        if (!matchesVersion(found.value.row, input.expectedUpdatedAt)) return err(versionConflict());
        if (found.value.row.status !== 'cancelled') return err(validationError('该排期不能恢复', 'occurrenceId'));
        const fields = toSchedule(found.value.row, cipher);
        const original = found.value.row.recurrenceRuleId && found.value.row.recurrenceDay
          ? { ruleId: found.value.row.recurrenceRuleId, day: localDay(found.value.row.recurrenceDay) }
          : undefined;
        if (await conflictForOccurrence(tx, teacherId, fields, found.value.row.id, original)) return err(validationError('恢复会与现有排期冲突', 'time'));
        await tx.schedule.update({ where: { id: found.value.row.id }, data: { status: 'planned' } });
        return buildState(tx, teacherId);
      });
    },
    async complete(teacherId, occurrenceId, input) {
      const fingerprint = createHash('sha256').update(JSON.stringify({ kind: 'complete', payload: { occurrenceId, input } })).digest('hex');
      return transact(teacherId, async (tx) => {
        // Receipt lookup is deliberately first. Retrying a successful command
        // must not re-run conflict/CAS checks against its own materialization.
        const existing = await tx.schedulingWebMutationReceipt.findFirst({ where: { teacherId, clientRequestId: input.clientRequestId } });
        if (existing) return existing.fingerprint === fingerprint ? buildState(tx, teacherId) : err(versionConflict());
        const found = await resolveOccurrence(tx, teacherId, occurrenceId); if (!found.ok) return found;
        if (!matchesVersion(found.value.row ?? found.value.rule, input.expectedUpdatedAt)) return err(versionConflict());
        const row = found.value.row ?? await materialize(tx, teacherId, occurrenceId);
        if (!row) return err(notFound('排期不存在'));
        try {
          const completed = await completionFor(tx).completeSchedule({ teacherId, scheduleId: row.id });
          if (!completed.ok) return completed;
        } catch (caught) {
          // The shared use case throws its rollback sentinel when reusing an
          // outer transaction. Convert only that sentinel back to Result, so
          // this service's transaction wrapper can roll back everything.
          if (caught && typeof caught === 'object' && 'result' in caught) return (caught as { result: Result<never, CommonError> }).result;
          throw caught;
        }
        await tx.schedulingWebMutationReceipt.create({ data: { teacherId, clientRequestId: input.clientRequestId, fingerprint } });
        return buildState(tx, teacherId);
      });
    },
    async editCompleted(teacherId, occurrenceId, input) {
      return mutate(teacherId, input.clientRequestId, 'edit-completed', { occurrenceId, input }, async (tx) => {
        const valid = await validateFields(tx, teacherId, input); if (!valid.ok) return valid;
        const found = await resolveOccurrence(tx, teacherId, occurrenceId); if (!found.ok || !found.value.row) return found.ok ? err(notFound('已完成排期不存在')) : found;
        if (!matchesVersion(found.value.row, input.expectedUpdatedAt)) return err(versionConflict());
        if (found.value.row.status !== 'completed') return err(validationError('仅已完成课程可修订', 'occurrenceId'));
        const before = toSchedule(found.value.row, cipher);
        const replay = await tx.scheduleRevision.findFirst({ where: { teacherId, scheduleId: found.value.row.id, clientRequestId: input.clientRequestId } });
        if (!replay) {
          const updated = await tx.schedule.update({ where: { id: found.value.row.id }, data: { ...scheduleUpdate(input, cipher, teacherId), status: 'completed' }, include: scheduleInclude });
          const after = toSchedule(updated, cipher);
          await tx.scheduleRevision.create({ data: { teacherId, scheduleId: found.value.row.id, clientRequestId: input.clientRequestId, beforeCiphertext: encryptSnapshot(before, cipher), afterCiphertext: encryptSnapshot(after, cipher) } });
        }
        return buildState(tx, teacherId);
      });
    },
  };
}

function formatDb(value: WebFormat) { return value === '一对一' ? 'one_to_one' : 'small_group'; }
function formatWeb(value: string | null): WebFormat {
  if (value === 'one_to_one') return '一对一';
  if (value === 'small_group') return '小班';
  throw new Error(`unsupported class format: ${value ?? 'null'}`);
}
function statusWeb(value: string): WebStatus {
  if (value === 'planned' || value === 'extra') return '已排期';
  if (value === 'completed') return '已完成';
  if (value === 'cancelled') return '已取消';
  throw new Error(`unsupported scheduling status: ${value}`);
}
function unique<T>(values: readonly T[]) { return [...new Set(values)]; }
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dateOnly(value);
  // `new Date('2026-02-30')` normalizes to March 2.  Match the canonical
  // serialization so only actual calendar days enter schedule/rule state.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validTime(value: string) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function dateOnly(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function instant(day: string, time: string) { return new Date(`${day}T${time}:00+08:00`); }
function parts(date: Date) { return Object.fromEntries(shanghai.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])); }
function localDay(date: Date) { const p = parts(date); return `${p.year}-${p.month}-${p.day}`; }
function localTime(date: Date) { const p = parts(date); return `${p.hour}:${p.minute}`; }
function addDays(day: string, amount: number) { const value = dateOnly(day); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); }
function weekday(day: string) { const value = dateOnly(day).getUTCDay(); return value === 0 ? 7 : value; }
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) { return aStart < bEnd && aEnd > bStart; }
function ruleDay(value: string | Date) { return typeof value === 'string' ? value : localDay(value); }
function occurs(rule: { enabled?: boolean; startDate: string | Date; endDate?: string | Date | null; weekdays: unknown }, day: string) { const days = Array.isArray(rule.weekdays) ? rule.weekdays : []; return rule.enabled !== false && day >= ruleDay(rule.startDate) && (!rule.endDate || day <= ruleDay(rule.endDate)) && days.includes(weekday(day)); }
function recurringIntersects(candidate: WebRuleInput, existing: any) {
  const existingStart = localDay(existing.startDate); const existingEnd = existing.endDate ? localDay(existing.endDate) : undefined;
  const first = candidate.startDate > existingStart ? candidate.startDate : existingStart;
  const last = !candidate.endDate ? existingEnd : !existingEnd ? candidate.endDate : candidate.endDate < existingEnd ? candidate.endDate : existingEnd;
  if (last && last < first) return false;
  const theirs = Array.isArray(existing.weekdays) ? existing.weekdays : [];
  return unique(candidate.weekdays).some((day) => theirs.includes(day) && (!last || addDays(first, (day - weekday(first) + 7) % 7) <= last));
}
function synthetic(value: string) { const marker = value.lastIndexOf('@'); const day = value.slice(marker + 1); return marker > 0 && validDate(day) ? { ruleId: value.slice(0, marker), day } : undefined; }
function matchesVersion(row: { updatedAtTs?: Date } | undefined, expected: string | undefined) { return !!expected && !!row?.updatedAtTs && row.updatedAtTs.toISOString() === expected; }
function toSchedule(row: any, cipher: FieldCipher | undefined): WebSchedule {
  const updatedAt = row.updatedAtTs.toISOString();
  return { id: row.id, day: localDay(row.scheduledStartTs), start: localTime(row.scheduledStartTs), end: localTime(row.scheduledEndTs), location: row.locationCiphertext ? decryptFieldValue(cipher, row.locationCiphertext) : '', participants: (row.participants ?? []).map((p: any) => p.studentId), format: formatWeb(row.classFormat), note: row.operationalNoteCiphertext ? decryptFieldValue(cipher, row.operationalNoteCiphertext) : '', status: statusWeb(row.status), ...(row.recurrenceRuleId ? { recurrenceRuleId: row.recurrenceRuleId } : {}), ...(row.recurrenceDay ? { recurrenceDay: localDay(row.recurrenceDay) } : {}), updatedAt, version: updatedAt };
}
function toRule(row: any, cipher: FieldCipher | undefined): WebRule { const updatedAt = row.updatedAtTs.toISOString(); return { id: row.id, startDate: localDay(row.startDate), weekdays: Array.isArray(row.weekdays) ? row.weekdays as number[] : [], ...(row.endDate ? { endDate: localDay(row.endDate) } : {}), enabled: row.enabled, start: row.startTime, end: row.endTime, location: decryptFieldValue(cipher, row.locationCiphertext), participants: (row.participants ?? []).map((p: any) => p.studentId), format: formatWeb(row.classFormat), note: row.operationalNoteCiphertext ? decryptFieldValue(cipher, row.operationalNoteCiphertext) : '', updatedAt, version: updatedAt }; }
function ruleFields(rule: any, cipher: FieldCipher | undefined, day: string): WebFields { const dto = toRule(rule, cipher); return { day, start: dto.start, end: dto.end, location: dto.location, participants: dto.participants, format: dto.format, note: dto.note }; }
function ruleToInput(rule: any, cipher: FieldCipher | undefined): WebRuleInput { const dto = toRule(rule, cipher); return { startDate: dto.startDate, weekdays: dto.weekdays, endDate: dto.endDate, enabled: dto.enabled, start: dto.start, end: dto.end, location: dto.location, participants: dto.participants, format: dto.format, note: dto.note }; }
function ruleCreate(teacherId: string, input: WebRuleInput, cipher: FieldCipher | undefined, clientRequestId: string) { return { teacherId, clientRequestId, startDate: dateOnly(input.startDate), endDate: input.endDate ? dateOnly(input.endDate) : null, weekdays: unique(input.weekdays), enabled: input.enabled !== false, startTime: input.start, endTime: input.end, locationCiphertext: encryptFieldValue(cipher, input.location.trim()), classFormat: formatDb(input.format), operationalNoteCiphertext: input.note?.trim() ? encryptFieldValue(cipher, input.note.trim()) : null, participants: { create: unique(input.participants).map((studentId) => ({ teacherId, studentId })) } }; }
function scheduleUpdate(input: WebFields, cipher: FieldCipher | undefined, teacherId: string) { return { studentId: unique(input.participants)[0] ?? null, scheduledStartTs: instant(input.day, input.start), scheduledEndTs: instant(input.day, input.end), locationCiphertext: encryptFieldValue(cipher, input.location.trim()), classFormat: formatDb(input.format), operationalNoteCiphertext: input.note?.trim() ? encryptFieldValue(cipher, input.note.trim()) : null, participants: { deleteMany: {}, create: unique(input.participants).map((studentId) => ({ teacherId, studentId })) } }; }
function encryptSnapshot(value: WebSchedule, cipher: FieldCipher | undefined) { if (!cipher) throw new Error('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY——拒绝明文落库'); return cipher.encryptJson(value); }
function decryptSnapshot(value: string, cipher: FieldCipher | undefined) { if (!cipher) throw new Error('SAFETY_BLOCK: 缺少 ENCRYPTION_KEY 无法解密已加密字段'); return cipher.decryptJson<WebSchedule>(value); }
