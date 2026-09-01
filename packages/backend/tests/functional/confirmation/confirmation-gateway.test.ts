import { describe, expect, it, vi } from 'vitest';
import { ok } from '@teacher-platform/contracts';
import { createConfirmationGateway } from '../../../src/app/confirmation/confirmation-gateway.js';
import type { CreatePendingActionInput } from '../../../src/features/pending-action/index.js';
import type { CreateConfirmationGatewayOptions } from '../../../src/app/confirmation/types.js';

const TEACHER = 'teacher-1';

function dependencies(overrides: Partial<CreateConfirmationGatewayOptions> = {}) {
  let captured: CreatePendingActionInput | undefined;
  const pendingActions = {
    createPendingAction: vi.fn(async (input: CreatePendingActionInput) => {
      captured = input;
      return ok({
        pendingAction: {
          id: 'pending-1',
          teacherId: input.teacherId,
          conversationId: input.conversationId,
          toolCallId: input.toolCallId,
          actionName: input.actionName,
          targetType: input.target.type,
          targetId: input.target.id,
          parameters: input.parameters,
          beforeSummary: input.beforeSummary,
          afterSummary: input.afterSummary,
          status: 'pending' as const,
          expiresAt: new Date('2030-01-01T00:10:00.000Z'),
          consumedAt: null,
          cancelledAt: null,
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
        },
        actionToken: 'must-not-leak-token',
      });
    }),
  };
  const options: CreateConfirmationGatewayOptions = {
    pendingActions,
    schedules: {
      getSchedule: vi.fn(async (id: string) => ok({
        id,
        teacherId: TEACHER,
        studentId: null,
        type: 'lesson',
        title: '测试日程',
        scheduledStart: new Date('2030-01-01T08:00:00.000Z'),
        scheduledEnd: new Date('2030-01-01T09:00:00.000Z'),
        status: 'planned',
        confidence: null,
        pendingFields: null,
        sourceInput: null,
        parentId: null,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
        updatedAt: new Date('2030-01-01T00:00:00.000Z'),
      })),
    },
    lessons: {
      getLesson: vi.fn(async (id: string) => ok({
        id,
        teacherId: TEACHER,
        studentId: 'student-1',
        scheduleId: 'schedule-1',
        date: new Date('2030-01-01T08:00:00.000Z'),
        status: 'pending',
        progress: null,
        studentState: null,
        homework: null,
        teacherNote: null,
        sourceNoteId: null,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
        updatedAt: new Date('2030-01-01T00:00:00.000Z'),
      })),
    },
    students: {
      getStudent: vi.fn(async (id: string) => ok({
        id,
        teacherId: TEACHER,
        name: '测试学生',
        grade: '高一',
        source: null,
        currentStatus: 'active',
        stageGoal: null,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
        updatedAt: new Date('2030-01-01T00:00:00.000Z'),
      })),
    },
    editOwners: {} as CreateConfirmationGatewayOptions['editOwners'],
    ...overrides,
  };
  return { options, pendingActions, captured: () => captured };
}

const scenarios = [
  {
    toolName: 'scheduling.complete',
    args: { scheduleId: 'schedule-1', confirm: true, actionToken: 'malicious' },
    expected: {
      actionName: 'scheduling.complete',
      target: { type: 'Schedule', id: 'schedule-1' },
      parameters: { scheduleId: 'schedule-1' },
      beforeSummary: '日程当前状态：planned',
      afterSummary: '日程将更新为 completed',
    },
  },
  {
    toolName: 'scheduling.cancel',
    args: { scheduleId: 'schedule-1', teacherId: 'other' },
    expected: {
      actionName: 'scheduling.cancel',
      target: { type: 'Schedule', id: 'schedule-1' },
      parameters: { scheduleId: 'schedule-1' },
      beforeSummary: '日程当前状态：planned',
      afterSummary: '日程将更新为 cancelled',
    },
  },
  {
    toolName: 'lessons.updateStatus',
    args: { lessonId: 'lesson-1', status: 'attended', nested: { hidden: true } },
    expected: {
      actionName: 'lessons.updateStatus',
      target: { type: 'Lesson', id: 'lesson-1' },
      parameters: { lessonId: 'lesson-1', status: 'attended' },
      beforeSummary: '课次当前状态：pending',
      afterSummary: '课次将更新为 attended',
    },
  },
  {
    toolName: 'students.updateStatus',
    args: { studentId: 'student-1', status: 'paused', parameters: { status: 'finished' } },
    expected: {
      actionName: 'students.updateStatus',
      target: { type: 'Student', id: 'student-1' },
      parameters: { studentId: 'student-1', status: 'paused' },
      beforeSummary: '学生当前状态：active',
      afterSummary: '学生将更新为 paused',
    },
  },
] as const;

describe('ConfirmationGateway', () => {
  it.each(scenarios)('$toolName 白名单重建 PendingAction intent 且不泄露 token', async (scenario) => {
    const deps = dependencies();
    const gateway = createConfirmationGateway(deps.options);

    const result = await gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: `call-${scenario.toolName}`,
      toolName: scenario.toolName,
      args: scenario.args,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'pending_confirmation',
        pendingActionId: 'pending-1',
        summary: scenario.expected.afterSummary,
      },
    });
    expect(deps.captured()).toMatchObject({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: `call-${scenario.toolName}`,
      ...scenario.expected,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak-token');
    expect(JSON.stringify(deps.captured())).not.toContain('malicious');
  });

  it('未知动作与非法参数在创建 PendingAction 前失败', async () => {
    const deps = dependencies();
    const gateway = createConfirmationGateway(deps.options);

    const unknown = await gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: 'call-unknown',
      toolName: 'payments.delete',
      args: {},
    });
    const invalid = await gateway.requestConfirmation({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: 'call-invalid',
      toolName: 'students.updateStatus',
      args: { studentId: '', status: 'paused' },
    });

    expect(unknown).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'toolName' } });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'studentId' } });
    expect(deps.pendingActions.createPendingAction).not.toHaveBeenCalled();
  });

  it('跨 teacher 返回 NOT_FOUND，非法状态机保持字段错误', async () => {
    const crossDeps = dependencies({
      students: {
        getStudent: vi.fn(async (id: string) => ok({
          id,
          teacherId: 'other-teacher',
          name: '其他学生',
          grade: '高一',
          source: null,
          currentStatus: 'active',
          stageGoal: null,
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
        })),
      },
    });
    const terminalDeps = dependencies({
      students: {
        getStudent: vi.fn(async (id: string) => ok({
          id,
          teacherId: TEACHER,
          name: '终态学生',
          grade: '高一',
          source: null,
          currentStatus: 'finished',
          stageGoal: null,
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
        })),
      },
    });

    const cross = await createConfirmationGateway(crossDeps.options).requestConfirmation({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: 'call-cross',
      toolName: 'students.updateStatus',
      args: { studentId: 'student-1', status: 'paused' },
    });
    const terminal = await createConfirmationGateway(terminalDeps.options).requestConfirmation({
      teacherId: TEACHER,
      conversationId: 'conversation-1',
      toolCallId: 'call-terminal',
      toolName: 'students.updateStatus',
      args: { studentId: 'student-1', status: 'paused' },
    });

    expect(cross).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(terminal).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'currentStatus' } });
    expect(crossDeps.pendingActions.createPendingAction).not.toHaveBeenCalled();
    expect(terminalDeps.pendingActions.createPendingAction).not.toHaveBeenCalled();
  });
});
