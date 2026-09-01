import { describe, expect, it, vi } from 'vitest';
import { notFound, ok } from '@teacher-platform/contracts';
import { createConfirmationGateway } from '../../../src/app/confirmation/confirmation-gateway.js';
import type { CreateConfirmationGatewayOptions } from '../../../src/app/confirmation/types.js';
import type { CreatePendingActionInput } from '../../../src/features/pending-action/index.js';
import type { StudentData } from '../../../src/features/students/index.js';

// P29-W1（第二最小切片）：ConfirmationGateway 的 payments.create（创建型确认）契约。
// 实现缺失时 requestConfirmation 落入默认分支（VALIDATION_ERROR '工具不支持可信确认'），
// 契约断言红灯；实现落盘后作为契约回归套件：
// - args 严格 allowlist {studentId, amount, lessonCount, paidAt, note?}
// - 通过 students.getStudent(studentId) 读取学生并校验 teacherId 归属；
//   跨 teacher/不存在统一 NOT_FOUND，不创建 PendingAction
// - 只保存 allowlist 参数 + 服务端 expectedUpdatedAt（学生版本快照）+ 无敏感正文的短摘要
// - target 固定 { type: 'Student', id: studentId }，actionName 固定 'payments.create'

const UPDATED_AT = new Date('2030-03-01T00:00:00.123Z');
const ACTION_TOKEN = 'secret-token';

const ownedStudent: StudentData = {
  id: 'student-1',
  teacherId: 'teacher-1',
  name: '张三',
  grade: '高一',
  source: 'test',
  currentStatus: 'active',
  stageGoal: null,
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
};

const VALID_ARGS = {
  studentId: 'student-1',
  amount: 1200,
  lessonCount: 10,
  paidAt: '2026-07-21T12:00:00.000Z',
  note: '暑期课包',
};

function dependencies() {
  let captured: CreatePendingActionInput | undefined;
  const students = {
    getStudent: vi.fn(async () => ok(ownedStudent)),
  };
  const options = {
    pendingActions: {
      createPendingAction: vi.fn(async (input: CreatePendingActionInput) => {
        captured = input;
        return ok({
          pendingAction: {
            id: 'pending-1', teacherId: input.teacherId, conversationId: input.conversationId,
            toolCallId: input.toolCallId, actionName: input.actionName, targetType: input.target.type,
            targetId: input.target.id, parameters: input.parameters, beforeSummary: input.beforeSummary,
            afterSummary: input.afterSummary, status: 'pending' as const,
            expiresAt: new Date('2030-03-01T00:10:00Z'),
            consumedAt: null, cancelledAt: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT,
          },
          actionToken: ACTION_TOKEN,
        });
      }),
    },
    schedules: { getSchedule: vi.fn() },
    lessons: { getLesson: vi.fn() },
    students,
    editOwners: {},
  } as unknown as CreateConfirmationGatewayOptions;
  return { options, students, captured: () => captured };
}

describe('P29-W1 ConfirmationGateway payments.create 契约', () => {
  it('合法参数通过学生归属校验创建 PendingAction：allowlist 参数 + 服务端 expectedUpdatedAt 快照 + Student target', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-payment-create-1',
      toolName: 'payments.create',
      args: VALID_ARGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending_confirmation');
    expect(deps.students.getStudent).toHaveBeenCalledWith('student-1');
    expect(deps.captured()).toMatchObject({
      actionName: 'payments.create',
      target: { type: 'Student', id: 'student-1' },
      parameters: {
        studentId: 'student-1',
        amount: 1200,
        lessonCount: 10,
        paidAt: '2026-07-21T12:00:00.000Z',
        note: '暑期课包',
        expectedUpdatedAt: UPDATED_AT.toISOString(),
      },
    });
    expect(deps.captured()?.beforeSummary).toBeTruthy();
    expect(deps.captured()?.afterSummary).toBeTruthy();
  });

  it('未提供 note 时 parameters 不含 note 键（allowlist 原样保留）', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-payment-create-2',
      toolName: 'payments.create',
      args: { studentId: 'student-1', amount: 1200, lessonCount: 10, paidAt: '2026-07-21T12:00:00.000Z' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.captured()?.parameters).toEqual({
      studentId: 'student-1',
      amount: 1200,
      lessonCount: 10,
      paidAt: '2026-07-21T12:00:00.000Z',
      expectedUpdatedAt: UPDATED_AT.toISOString(),
    });
  });

  it('allowlist 严格：confirm/teacherId/actionToken/source/expectedUpdatedAt/extra/嵌套 parameters 全部拒绝，不读学生、不创建 PendingAction', async () => {
    const invalidArgs = [
      { ...VALID_ARGS, confirm: true },
      { ...VALID_ARGS, teacherId: 'other-teacher' },
      { ...VALID_ARGS, actionToken: 'malicious' },
      { ...VALID_ARGS, source: 'system' },
      { ...VALID_ARGS, expectedUpdatedAt: UPDATED_AT.toISOString() },
      { ...VALID_ARGS, extra: 'x' },
      { ...VALID_ARGS, parameters: { amount: 1 } },
      { ...VALID_ARGS, changes: { amount: 1 } },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-invalid',
        toolName: 'payments.create',
        args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
      expect(deps.captured()).toBeUndefined();
      expect(deps.students.getStudent).not.toHaveBeenCalled();
    }
  });

  it('非法金额/课时/缴费时间/备注在创建 PendingAction 前拒绝（不读学生）', async () => {
    const invalidArgs = [
      { ...VALID_ARGS, amount: 0 },
      { ...VALID_ARGS, amount: -100 },
      { ...VALID_ARGS, amount: '1200' },
      { ...VALID_ARGS, lessonCount: 0 },
      { ...VALID_ARGS, lessonCount: 10.5 },
      { ...VALID_ARGS, lessonCount: '10' },
      { ...VALID_ARGS, paidAt: '2026-07-21' },
      { ...VALID_ARGS, paidAt: 'bad-date' },
      { ...VALID_ARGS, paidAt: 123 },
      { ...VALID_ARGS, note: 123 },
      { ...VALID_ARGS, studentId: '' },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-bad-value',
        toolName: 'payments.create',
        args,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(['studentId', 'amount', 'lessonCount', 'paidAt', 'note']).toContain(result.error.field);
      expect(deps.captured()).toBeUndefined();
      expect(deps.students.getStudent).not.toHaveBeenCalled();
    }
  });

  it('学生属于其他 teacher 时统一 NOT_FOUND 且不创建 PendingAction', async () => {
    const deps = dependencies();
    deps.students.getStudent.mockResolvedValueOnce(ok({ ...ownedStudent, teacherId: 'other-teacher' }));

    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-cross',
      toolName: 'payments.create',
      args: VALID_ARGS,
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(deps.captured()).toBeUndefined();
  });

  it('学生不存在时透传 NOT_FOUND 且不创建 PendingAction', async () => {
    const deps = dependencies();
    deps.students.getStudent.mockResolvedValueOnce({ ok: false, error: notFound('学生不存在') });

    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-missing',
      toolName: 'payments.create',
      args: VALID_ARGS,
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(deps.captured()).toBeUndefined();
  });

  it('摘要只含金额/课时/学生名，不含备注正文、expectedUpdatedAt、actionToken', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-summary',
      toolName: 'payments.create',
      args: VALID_ARGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const captured = deps.captured();
    expect(captured).toBeDefined();
    const summary = `${captured?.beforeSummary ?? ''}\n${captured?.afterSummary ?? ''}`;
    expect(summary.length).toBeLessThanOrEqual(480);
    expect(summary).toContain('1200');
    expect(summary).toContain('10');
    expect(summary).toContain('张三');
    expect(summary).not.toContain('暑期课包');
    expect(summary).not.toContain('expectedUpdatedAt');
    expect(summary).not.toContain(ACTION_TOKEN);
    expect(summary).not.toContain('actionToken');
  });
});
