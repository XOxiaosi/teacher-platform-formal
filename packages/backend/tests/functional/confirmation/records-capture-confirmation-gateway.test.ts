import { describe, expect, it, vi } from 'vitest';
import { notFound, ok } from '@teacher-platform/contracts';
import { createConfirmationGateway } from '../../../src/app/confirmation/confirmation-gateway.js';
import type { CreateConfirmationGatewayOptions } from '../../../src/app/confirmation/types.js';
import type { CreatePendingActionInput } from '../../../src/features/pending-action/index.js';
import type { StudentData } from '../../../src/features/students/index.js';

// P29-W1（第三最小切片）：ConfirmationGateway 的 students.records.capture（创建型确认）契约。
// 实现缺失时 requestConfirmation 落入默认分支（VALIDATION_ERROR '工具不支持可信确认'），
// 契约断言红灯；实现落盘后作为契约回归套件：
// - args 严格 allowlist {studentId, category, summary, occurredAt?, sourceText?,
//   sourceEntityType?, sourceEntityId?, confidence?, visibility?, importance?}
// - 通过 students.getStudent(studentId) 读取学生并校验 teacherId 归属；
//   跨 teacher/不存在统一 NOT_FOUND，不创建 PendingAction
// - 只保存 allowlist 参数 + 服务端 expectedUpdatedAt（学生版本快照）+ 无敏感正文的短摘要
// - target 固定 { type: 'Student', id: studentId }，actionName 固定 'students.records.capture'

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
  category: 'learning_state',
  summary: '本周学习状态稳定',
  occurredAt: '2026-07-21T12:00:00.000Z',
  sourceText: '课堂观察原始文本',
  sourceEntityType: 'Lesson',
  sourceEntityId: 'lesson-1',
  confidence: 'high',
  visibility: 'parent_shareable',
  importance: 'important',
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

describe('P29-W1 ConfirmationGateway students.records.capture 契约', () => {
  it('合法参数通过学生归属校验创建 PendingAction：allowlist 参数 + 服务端 expectedUpdatedAt 快照 + Student target', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-records-capture-1',
      toolName: 'students.records.capture',
      args: VALID_ARGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending_confirmation');
    expect(deps.students.getStudent).toHaveBeenCalledWith('student-1');
    expect(deps.captured()).toMatchObject({
      actionName: 'students.records.capture',
      target: { type: 'Student', id: 'student-1' },
      parameters: {
        studentId: 'student-1',
        category: 'learning_state',
        summary: '本周学习状态稳定',
        occurredAt: '2026-07-21T12:00:00.000Z',
        sourceText: '课堂观察原始文本',
        sourceEntityType: 'Lesson',
        sourceEntityId: 'lesson-1',
        confidence: 'high',
        visibility: 'parent_shareable',
        importance: 'important',
        expectedUpdatedAt: UPDATED_AT.toISOString(),
      },
    });
    expect(deps.captured()?.beforeSummary).toBeTruthy();
    expect(deps.captured()?.afterSummary).toBeTruthy();
  });

  it('未提供可选字段时 parameters 不含这些键（allowlist 原样保留）', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-records-capture-2',
      toolName: 'students.records.capture',
      args: { studentId: 'student-1', category: 'learning_state', summary: '本周学习状态稳定' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.captured()?.parameters).toEqual({
      studentId: 'student-1',
      category: 'learning_state',
      summary: '本周学习状态稳定',
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
      { ...VALID_ARGS, parameters: { category: 'goal' } },
      { ...VALID_ARGS, changes: { summary: 'x' } },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-invalid',
        toolName: 'students.records.capture',
        args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
      expect(deps.captured()).toBeUndefined();
      expect(deps.students.getStudent).not.toHaveBeenCalled();
    }
  });

  it('非对象 args（null/字符串/数组/数字）在创建 PendingAction 前拒绝', async () => {
    for (const args of [null, 'string-args', [1, 2], 42]) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-non-object',
        toolName: 'students.records.capture',
        args,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'args' } });
      expect(deps.captured()).toBeUndefined();
      expect(deps.students.getStudent).not.toHaveBeenCalled();
    }
  });

  it('非法类别/置信度/可见性/重要性/时间/摘要在创建 PendingAction 前拒绝（不读学生）', async () => {
    const invalidArgs = [
      { ...VALID_ARGS, category: 'invalid' },
      { ...VALID_ARGS, confidence: 'maybe' },
      { ...VALID_ARGS, visibility: 'public' },
      { ...VALID_ARGS, importance: 'urgent' },
      { ...VALID_ARGS, occurredAt: '2026-07-21' },
      { ...VALID_ARGS, occurredAt: '2026-07-21T12:00:00' },
      { ...VALID_ARGS, occurredAt: 'bad-date' },
      { ...VALID_ARGS, occurredAt: 123 },
      { ...VALID_ARGS, summary: '' },
      { ...VALID_ARGS, summary: '   ' },
      { ...VALID_ARGS, summary: 123 },
      { ...VALID_ARGS, studentId: '' },
    ];

    for (const args of invalidArgs) {
      const deps = dependencies();
      const result = await createConfirmationGateway(deps.options).requestConfirmation({
        teacherId: 'teacher-1',
        conversationId: 'conversation-1',
        toolCallId: 'call-bad-value',
        toolName: 'students.records.capture',
        args,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect([
        'studentId', 'category', 'summary', 'occurredAt',
        'confidence', 'visibility', 'importance',
      ]).toContain(result.error.field);
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
      toolName: 'students.records.capture',
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
      toolName: 'students.records.capture',
      args: VALID_ARGS,
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect(deps.captured()).toBeUndefined();
  });

  it('摘要只含非敏感信息：不含 summary/sourceText 明文、expectedUpdatedAt、actionToken', async () => {
    const deps = dependencies();
    const result = await createConfirmationGateway(deps.options).requestConfirmation({
      teacherId: 'teacher-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-summary',
      toolName: 'students.records.capture',
      args: VALID_ARGS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const captured = deps.captured();
    expect(captured).toBeDefined();
    const summary = `${captured?.beforeSummary ?? ''}\n${captured?.afterSummary ?? ''}`;
    expect(summary.length).toBeLessThanOrEqual(480);
    expect(summary).toContain('张三');
    expect(summary).not.toContain('本周学习状态稳定');
    expect(summary).not.toContain('课堂观察原始文本');
    expect(summary).not.toContain('expectedUpdatedAt');
    expect(summary).not.toContain(ACTION_TOKEN);
    expect(summary).not.toContain('actionToken');
  });
});
