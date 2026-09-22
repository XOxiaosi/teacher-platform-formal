import type {
  AgendaItem,
  AgendaTodayDocument,
  AgendaWeekDocument,
  ObjectReference,
  PresentationAction,
  PresentationObjectType,
} from '@teacher-platform/contracts';
import type { MemoData } from '../../features/memos/types.js';
import type { PendingActionData } from '../../features/pending-action/types.js';
import type { ScheduleData } from '../../features/scheduling/types.js';
import type { StudentData } from '../../features/students/types.js';
import { getOverlappingBusinessDates } from './business-calendar.js';
import type { ProjectAgendaTodayInput, ProjectAgendaWeekInput } from './types.js';

const MAX_TITLE_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;

function bounded(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function validDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function reference(
  type: PresentationObjectType,
  objectId: string,
  label: string,
): ObjectReference {
  return {
    id: `${type}:${objectId}`,
    type,
    objectId,
    label: bounded(label, MAX_LABEL_LENGTH),
  };
}

function openAction(sourceRef: ObjectReference): PresentationAction {
  return {
    id: `open:${sourceRef.id}`,
    kind: 'open-reference',
    label: bounded(`查看${sourceRef.label}`, MAX_LABEL_LENGTH),
    referenceId: sourceRef.id,
  };
}

function studentReferences(students: readonly StudentData[]): Map<string, ObjectReference> {
  return new Map(students.map((student) => [
    student.id,
    reference('Student', student.id, student.name),
  ]));
}

function lessonItem(
  schedule: ScheduleData,
  students: ReadonlyMap<string, ObjectReference>,
): AgendaItem | null {
  if (
    schedule.type !== 'lesson'
    || !validDate(schedule.scheduledStart)
    || !validDate(schedule.scheduledEnd)
  ) return null;
  // T-016: an Agenda course deliberately has no course-name surface. The
  // legacy Schedule.title must not enter either item title or reference label.
  const sourceRef = reference('Schedule', schedule.id, '课程安排');
  const participantIds = [...new Set(schedule.participantIds?.length
    ? schedule.participantIds
    : (schedule.studentId ? [schedule.studentId] : []))];
  const participantRefs = participantIds
    .map((studentId) => students.get(studentId))
    .filter((student): student is ObjectReference => student !== undefined);
  const isSmallGroup = schedule.classFormat === 'small_group' || participantIds.length > 1;
  const studentRef = !isSmallGroup && participantRefs.length === 1
    ? participantRefs[0]
    : undefined;
  const participantLabel = isSmallGroup
    ? (participantIds.length >= 2 ? `小班（${participantIds.length}人）` : undefined)
    : studentRef?.label;
  return {
    id: `schedule:${schedule.id}`,
    kind: 'lesson',
    title: '课程安排',
    startAt: schedule.scheduledStart.toISOString(),
    endAt: schedule.scheduledEnd.toISOString(),
    allDay: false,
    status: schedule.status,
    ...(studentRef ? { studentRef } : {}),
    lessonDetails: {
      ...(schedule.location ? { location: schedule.location } : {}),
      ...(participantLabel ? { participantLabel } : {}),
    },
    sourceRef,
    actions: [openAction(sourceRef)],
  };
}

function memoItem(memo: MemoData): AgendaItem | null {
  if (memo.status !== 'active' || !validDate(memo.dueAt)) return null;
  const sourceRef = reference('Memo', memo.id, memo.title);
  return {
    id: `memo:${memo.id}`,
    kind: 'memo',
    title: bounded(memo.title, MAX_TITLE_LENGTH),
    startAt: memo.dueAt.toISOString(),
    allDay: true,
    status: 'active',
    sourceRef,
    actions: [openAction(sourceRef)],
  };
}

function pendingActionItem(
  pendingAction: PendingActionData,
  students: ReadonlyMap<string, ObjectReference>,
): AgendaItem | null {
  if (pendingAction.status !== 'pending' || !validDate(pendingAction.expiresAt)) return null;
  const resolvedStudent = pendingAction.targetType === 'Student'
    ? students.get(pendingAction.targetId)
    : undefined;
  const sourceRef = resolvedStudent ?? reference(
    pendingAction.targetType,
    pendingAction.targetId,
    pendingAction.afterSummary,
  );
  const actions = pendingAction.targetType === 'Lesson' ? [] : [openAction(sourceRef)];
  return {
    id: `pending-action:${pendingAction.id}`,
    kind: 'pending_action',
    title: bounded(pendingAction.afterSummary, MAX_TITLE_LENGTH),
    startAt: pendingAction.expiresAt.toISOString(),
    allDay: true,
    status: 'pending',
    sourceRef,
    actions,
  };
}

function itemGroup(item: AgendaItem): number {
  if (item.kind === 'lesson') return 0;
  if (item.kind === 'pending_action') return 1;
  if (item.kind === 'memo') return 2;
  return 3;
}

function compareAgendaItems(left: AgendaItem, right: AgendaItem): number {
  const groupDifference = itemGroup(left) - itemGroup(right);
  if (groupDifference !== 0) return groupDifference;

  const startDifference = compareText(left.startAt ?? '', right.startAt ?? '');
  if (startDifference !== 0) return startDifference;
  if (left.kind === 'lesson' && right.kind === 'lesson') {
    const endDifference = compareText(left.endAt ?? '', right.endAt ?? '');
    if (endDifference !== 0) return endDifference;
    return compareText(left.id, right.id);
  }
  const titleDifference = compareText(left.title, right.title);
  return titleDifference !== 0 ? titleDifference : compareText(left.id, right.id);
}

function uniqueSorted(items: readonly (AgendaItem | null)[]): AgendaItem[] {
  const unique = new Map<string, AgendaItem>();
  for (const item of items) {
    if (item && !unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].sort(compareAgendaItems);
}

function allItems(input: ProjectAgendaTodayInput | ProjectAgendaWeekInput): AgendaItem[] {
  const students = studentReferences(input.students);
  return uniqueSorted([
    ...input.schedules.map((schedule) => lessonItem(schedule, students)),
    ...input.pendingActions.map((action) => pendingActionItem(action, students)),
    ...input.memos.map(memoItem),
  ]);
}

function pointBusinessDate(
  instant: Date,
  days: readonly string[],
  timeZone: 'Asia/Shanghai',
): string | undefined {
  const endAt = new Date(instant.getTime() + 1);
  return getOverlappingBusinessDates({ startAt: instant, endAt, days, timeZone })[0];
}

export function projectAgendaToday(input: ProjectAgendaTodayInput): AgendaTodayDocument {
  return {
    schemaVersion: 1,
    timeZone: input.timeZone,
    businessDate: input.businessDate,
    generatedAt: input.generatedAt.toISOString(),
    items: allItems(input),
  };
}

export function projectAgendaWeek(input: ProjectAgendaWeekInput): AgendaWeekDocument {
  const students = studentReferences(input.students);
  const byDate = new Map(input.days.map((date) => [date, new Map<string, AgendaItem>()]));

  for (const schedule of input.schedules) {
    const item = lessonItem(schedule, students);
    if (!item) continue;
    for (const date of getOverlappingBusinessDates({
      startAt: schedule.scheduledStart,
      endAt: schedule.scheduledEnd,
      days: input.days,
      timeZone: input.timeZone,
    })) {
      byDate.get(date)?.set(item.id, item);
    }
  }

  const addPointItem = (item: AgendaItem | null, instant: Date | null) => {
    if (!item || !validDate(instant)) return;
    const date = pointBusinessDate(instant, input.days, input.timeZone);
    if (date) byDate.get(date)?.set(item.id, item);
  };
  for (const action of input.pendingActions) {
    addPointItem(pendingActionItem(action, students), action.expiresAt);
  }
  for (const memo of input.memos) addPointItem(memoItem(memo), memo.dueAt);

  return {
    schemaVersion: 1,
    timeZone: input.timeZone,
    weekStart: input.weekStart,
    weekEndExclusive: input.weekEndExclusive,
    generatedAt: input.generatedAt.toISOString(),
    days: input.days.map((date) => ({
      date,
      items: [...(byDate.get(date)?.values() ?? [])].sort(compareAgendaItems),
    })),
  };
}
