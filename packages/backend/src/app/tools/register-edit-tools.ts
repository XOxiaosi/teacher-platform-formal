import { err, validationError } from '@teacher-platform/contracts';
import type { ToolDefinition, ToolRegistry } from '../../shared/tool-registry/types.js';

const confirmationRequired = async () => err(
  validationError('该工具必须通过 ConfirmationGateway 创建待确认操作', 'confirmation'),
);

const nullableString = { type: ['string', 'null'] };
const jsonValue = { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] };

const EDIT_TOOLS: ToolDefinition[] = [
  {
    name: 'students.updateProfile',
    description: '为当前老师创建“更新学生资料”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        studentId: { type: 'string', description: '学生 ID' },
        changes: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            grade: { type: 'string' },
            stageGoal: nullableString,
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['studentId', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduling.reschedule',
    description: '为当前老师创建“改期计划课”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: '日程 ID' },
        replacement: {
          type: 'object',
          properties: {
            scheduledStart: { type: 'string', description: '带时区的 RFC 3339 开始时间' },
            scheduledEnd: { type: 'string', description: '带时区的 RFC 3339 结束时间' },
          },
          required: ['scheduledStart', 'scheduledEnd'],
          additionalProperties: false,
        },
      },
      required: ['scheduleId', 'replacement'],
      additionalProperties: false,
    },
  },
  {
    name: 'lessons.updateRecord',
    description: '为当前老师创建“更新课次记录”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        lessonId: { type: 'string', description: '课次 ID' },
        changes: {
          type: 'object',
          properties: {
            progress: nullableString,
            studentState: nullableString,
            homework: nullableString,
            teacherNote: nullableString,
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['lessonId', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'payments.update',
    description: '为当前老师创建“更新缴费记录”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        paymentId: { type: 'string', description: '缴费记录 ID' },
        changes: {
          type: 'object',
          properties: {
            amount: { type: 'number', exclusiveMinimum: 0 },
            lessonCount: { type: 'integer', minimum: 1 },
            paidAt: { type: 'string', description: '带时区的 RFC 3339 时间' },
            note: nullableString,
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['paymentId', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'memos.update',
    description: '为当前老师创建“更新备忘内容”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        memoId: { type: 'string', description: '备忘 ID' },
        changes: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            dueAt: nullableString,
            tags: jsonValue,
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['memoId', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'feedback.updateContent',
    description: '为当前老师创建“更新家长反馈内容”的待确认操作。',
    sideEffect: 'update',
    confirmation: 'required',
    parameters: {
      type: 'object',
      properties: {
        feedbackId: { type: 'string', description: '家长反馈 ID' },
        changes: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['feedbackId', 'changes'],
      additionalProperties: false,
    },
  },
];

export function registerEditTools(registry: ToolRegistry): void {
  for (const definition of EDIT_TOOLS) registry.register(definition, confirmationRequired);
}
