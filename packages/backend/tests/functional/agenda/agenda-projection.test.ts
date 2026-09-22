import { describe, expect, it } from 'vitest';
import type { AgendaTodayDocument, AgendaWeekDocument } from '@teacher-platform/contracts';
import type { ScheduleData } from '../../../src/features/scheduling/types.js';
import type { MemoData } from '../../../src/features/memos/types.js';
import type { PendingActionData } from '../../../src/features/pending-action/types.js';
import type { StudentData } from '../../../src/features/students/types.js';

interface ProjectionSources {
  generatedAt: Date;
  timeZone: 'Asia/Shanghai';
  schedules: ScheduleData[];
  memos: MemoData[];
  pendingActions: PendingActionData[];
  students: StudentData[];
}

interface ProjectionModule {
  projectAgendaToday?: (
    input: ProjectionSources & { businessDate: string },
  ) => AgendaTodayDocument;
  projectAgendaWeek?: (
    input: ProjectionSources & {
      weekStart: string;
      weekEndExclusive: string;
      days: string[];
    },
  ) => AgendaWeekDocument;
}

const NOW = new Date('2030-07-22T01:00:00.000Z');
const CREATED_AT = new Date('2030-07-01T00:00:00.000Z');

async function loadProjection(): Promise<ProjectionModule> {
  try {
    return await import('../../../src/app/agenda/agenda-projection.js');
  } catch {
    return {};
  }
}

function schedule(input: Partial<ScheduleData> & Pick<ScheduleData, 'id' | 'title'>): ScheduleData {
  return {
    id: input.id,
    teacherId: 'teacher-a',
    studentId: null,
    participantIds: [],
    type: 'lesson',
    title: input.title,
    location: null,
    classFormat: null,
    operationalNote: null,
    scheduledStart: new Date('2030-07-22T00:00:00.000Z'),
    scheduledEnd: new Date('2030-07-22T01:00:00.000Z'),
    status: 'planned',
    confidence: 'high',
    pendingFields: null,
    sourceInput: 'sensitive schedule source',
    parentId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

function memo(input: Partial<MemoData> & Pick<MemoData, 'id' | 'title'>): MemoData {
  return {
    id: input.id,
    teacherId: 'teacher-a',
    title: input.title,
    content: 'sensitive memo content',
    status: 'active',
    dueAt: new Date('2030-07-21T15:00:00.000Z'),
    tags: { secret: true },
    source: 'sensitive memo source',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

function pending(
  input: Partial<PendingActionData> & Pick<PendingActionData, 'id' | 'targetType' | 'targetId' | 'afterSummary'>,
): PendingActionData {
  return {
    id: input.id,
    teacherId: 'teacher-a',
    conversationId: 'sensitive-conversation',
    toolCallId: 'sensitive-tool-call',
    actionName: 'students.updateStatus',
    targetType: input.targetType,
    targetId: input.targetId,
    parameters: { secret: 'sensitive-parameters', route: 'https://must-not-leak.example' },
    beforeSummary: 'sensitive-before-summary',
    afterSummary: input.afterSummary,
    status: 'pending',
    expiresAt: new Date('2030-07-22T03:00:00.000Z'),
    consumedAt: null,
    cancelledAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

function student(input: Partial<StudentData> & Pick<StudentData, 'id' | 'name'>): StudentData {
  return {
    id: input.id,
    teacherId: 'teacher-a',
    name: input.name,
    grade: '高一',
    source: 'sensitive student source',
    currentStatus: 'active',
    stageGoal: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...input,
  };
}

describe('Agenda pure projection', () => {
  it('Today准确映射三种kind、稳定排序去重，并闭合sourceRef/action/studentRef', async () => {
    const projection = await loadProjection();
    expect(projection.projectAgendaToday).toBeTypeOf('function');
    if (!projection.projectAgendaToday) return;

    const lesson = schedule({
      id: 'schedule-1',
      title: '物理课',
      studentId: 'student-1',
      participantIds: ['student-1'],
      location: '工作室 A',
      classFormat: 'one_to_one',
      operationalNote: '先确认错题是否订正',
    });
    const result = projection.projectAgendaToday({
      generatedAt: NOW,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-22',
      schedules: [
        lesson,
        lesson,
        schedule({ id: 'schedule-meeting', title: '教研会', type: 'meeting' }),
      ],
      memos: [
        memo({ id: 'memo-1', title: '补发讲义' }),
        memo({ id: 'memo-1', title: '补发讲义' }),
      ],
      pendingActions: [
        pending({
          id: 'pending-2',
          targetType: 'Lesson',
          targetId: 'lesson-1',
          afterSummary: '完成课次',
          expiresAt: new Date('2030-07-22T04:00:00.000Z'),
        }),
        pending({
          id: 'pending-1',
          targetType: 'Student',
          targetId: 'student-1',
          afterSummary: '暂停学生',
          expiresAt: new Date('2030-07-22T03:00:00.000Z'),
        }),
      ],
      students: [student({ id: 'student-1', name: '小明' })],
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-22',
      generatedAt: NOW.toISOString(),
    });
    expect(result.items.map((item) => item.id)).toEqual([
      'schedule:schedule-1',
      'pending-action:pending-1',
      'pending-action:pending-2',
      'memo:memo-1',
    ]);

    const lessonItem = result.items[0];
    expect(lessonItem).toMatchObject({
      kind: 'lesson',
      title: '课程安排',
      startAt: lesson.scheduledStart.toISOString(),
      endAt: lesson.scheduledEnd.toISOString(),
      allDay: false,
      status: 'planned',
      sourceRef: {
        id: 'Schedule:schedule-1',
        type: 'Schedule',
        objectId: 'schedule-1',
        label: '课程安排',
      },
      studentRef: {
        id: 'Student:student-1',
        type: 'Student',
        objectId: 'student-1',
        label: '小明',
      },
      lessonDetails: {
        location: '工作室 A',
        participantLabel: '小明',
      },
    });
    expect(JSON.stringify(lessonItem)).not.toContain('物理课');
    expect(JSON.stringify(lessonItem)).not.toContain('先确认错题是否订正');
    expect(JSON.stringify(lessonItem)).not.toContain('one_to_one');
    expect(lessonItem?.actions).toHaveLength(1);
    expect(lessonItem?.actions[0]?.referenceId).toBe(lessonItem?.sourceRef.id);

    const safePending = result.items[1];
    expect(safePending?.sourceRef).toMatchObject({ id: 'Student:student-1', type: 'Student' });
    expect(safePending?.actions[0]?.referenceId).toBe(safePending?.sourceRef.id);
    expect(result.items[2]?.sourceRef).toMatchObject({ id: 'Lesson:lesson-1', type: 'Lesson' });
    expect(result.items[2]?.actions).toEqual([]);

    const memoItem = result.items[3];
    expect(memoItem).toMatchObject({
      kind: 'memo',
      title: '补发讲义',
      startAt: '2030-07-21T15:00:00.000Z',
      allDay: true,
      status: 'active',
      sourceRef: { id: 'Memo:memo-1', type: 'Memo', objectId: 'memo-1' },
    });
    expect(memoItem).not.toHaveProperty('endAt');
    expect(memoItem?.actions[0]?.referenceId).toBe(memoItem?.sourceRef.id);
  });

  it('小班摘要只显示班型与人数，不泄露完整名单或备注', async () => {
    const projection = await loadProjection();
    expect(projection.projectAgendaToday).toBeTypeOf('function');
    if (!projection.projectAgendaToday) return;

    const result = projection.projectAgendaToday({
      generatedAt: NOW,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-22',
      schedules: [schedule({
        id: 'schedule-group',
        title: '竞赛集训',
        studentId: 'student-1',
        participantIds: ['student-1', 'student-2'],
        location: '教室 2',
        classFormat: 'small_group',
        operationalNote: '小测后逐人讲解',
      })],
      memos: [],
      pendingActions: [],
      students: [
        student({ id: 'student-1', name: '小明' }),
        student({ id: 'student-2', name: '小红' }),
      ],
    });

    expect(result.items[0]).toMatchObject({
      title: '课程安排',
      lessonDetails: {
        location: '教室 2',
        participantLabel: '小班（2人）',
      },
    });
    expect(result.items[0]).not.toHaveProperty('studentRef');
    const serialized = JSON.stringify(result.items[0]);
    for (const forbidden of ['竞赛集训', '小明', '小红', '小测后逐人讲解', 'small_group']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('Today省略missing Student且不泄露owner敏感字段、token或URL', async () => {
    const projection = await loadProjection();
    expect(projection.projectAgendaToday).toBeTypeOf('function');
    if (!projection.projectAgendaToday) return;

    const result = projection.projectAgendaToday({
      generatedAt: NOW,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-22',
      schedules: [schedule({ id: 'schedule-missing', title: '无学生引用', studentId: 'missing' })],
      memos: [memo({ id: 'memo-secret', title: '安全标题' })],
      pendingActions: [pending({
        id: 'pending-secret',
        targetType: 'Schedule',
        targetId: 'schedule-missing',
        afterSummary: '安全摘要',
      })],
      students: [],
    });

    expect(result.items[0]).not.toHaveProperty('studentRef');
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'teacher-a',
      'sensitive memo content',
      'sensitive-parameters',
      'sensitive-before-summary',
      'sensitive-conversation',
      'sensitive-tool-call',
      'actionToken',
      'https://',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('确定性截断Agenda title至200字符、reference与action label至120字符', async () => {
    const projection = await loadProjection();
    expect(projection.projectAgendaToday).toBeTypeOf('function');
    if (!projection.projectAgendaToday) return;

    const longText = '长'.repeat(240);
    const result = projection.projectAgendaToday({
      generatedAt: NOW,
      timeZone: 'Asia/Shanghai',
      businessDate: '2030-07-22',
      schedules: [schedule({ id: 'schedule-long', title: longText, studentId: 'student-long' })],
      memos: [memo({ id: 'memo-long', title: longText })],
      pendingActions: [pending({
        id: 'pending-long',
        targetType: 'Student',
        targetId: 'student-long',
        afterSummary: longText,
      })],
      students: [student({ id: 'student-long', name: longText })],
    });

    expect(result.items.every((item) => item.title.length <= 200)).toBe(true);
    expect(result.items.every((item) => item.sourceRef.label.length <= 120)).toBe(true);
    expect(result.items.every((item) => (
      item.studentRef === undefined || item.studentRef.label.length <= 120
    ))).toBe(true);
    expect(result.items.flatMap((item) => item.actions).every((action) => action.label.length <= 120)).toBe(true);
  });

  it('Week生成连续7天，跨日lesson按真实相交日重复，Memo和PendingAction按上海业务日分桶', async () => {
    const projection = await loadProjection();
    expect(projection.projectAgendaWeek).toBeTypeOf('function');
    if (!projection.projectAgendaWeek) return;

    const days = [
      '2030-07-22',
      '2030-07-23',
      '2030-07-24',
      '2030-07-25',
      '2030-07-26',
      '2030-07-27',
      '2030-07-28',
    ];
    const result = projection.projectAgendaWeek({
      generatedAt: NOW,
      timeZone: 'Asia/Shanghai',
      weekStart: '2030-07-22',
      weekEndExclusive: '2030-07-29',
      days,
      schedules: [schedule({
        id: 'schedule-cross-day',
        title: '跨日课程',
        scheduledStart: new Date('2030-07-22T15:30:00.000Z'),
        scheduledEnd: new Date('2030-07-23T16:00:00.000Z'),
      })],
      memos: [
        memo({ id: 'memo-in-week', title: '周内备忘', dueAt: new Date('2030-07-24T02:00:00.000Z') }),
        memo({ id: 'memo-overdue', title: '历史逾期', dueAt: new Date('2030-07-20T02:00:00.000Z') }),
      ],
      pendingActions: [pending({
        id: 'pending-in-week',
        targetType: 'Student',
        targetId: 'student-1',
        afterSummary: '周内待确认',
        expiresAt: new Date('2030-07-25T02:00:00.000Z'),
      })],
      students: [student({ id: 'student-1', name: '小明' })],
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      timeZone: 'Asia/Shanghai',
      weekStart: '2030-07-22',
      weekEndExclusive: '2030-07-29',
      generatedAt: NOW.toISOString(),
    });
    expect(result.days.map((day) => day.date)).toEqual(days);
    expect(result.days[0]?.items.map((item) => item.id)).toEqual(['schedule:schedule-cross-day']);
    expect(result.days[1]?.items.map((item) => item.id)).toEqual(['schedule:schedule-cross-day']);
    expect(result.days[2]?.items.map((item) => item.id)).toEqual(['memo:memo-in-week']);
    expect(result.days[3]?.items.map((item) => item.id)).toEqual(['pending-action:pending-in-week']);
    expect(result.days.slice(4).every((day) => day.items.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('memo-overdue');
  });
});
