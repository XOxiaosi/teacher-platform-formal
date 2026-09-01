import type { PrismaClient } from '@prisma/client';
import { validationError } from '@teacher-platform/contracts';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createStudentSourceRecordService,
} from '../../features/student-records/index.js';
import type {
  SourceType,
  StudentRecordCategory,
  Confidence,
  Visibility,
  Importance,
} from '../../features/student-records/index.js';
import { createAssessmentService } from '../../features/assessments/index.js';
import type { CaptureCommunicationFromTextUseCase } from '../use-cases/capture-communication-from-text/types.js';

const SOURCE_TYPES: SourceType[] = [
  'agent_text',
  'manual',
  'lesson',
  'assessment',
  'audio',
  'image',
  'screenshot',
  'import',
];

// P29-W1：枚举集合导出复用——ConfirmationGateway 与 records-capture executor
// 复用同一份集合做创建前/确认时校验（避免复制漂移）。
export const CATEGORIES: StudentRecordCategory[] = [
  'assessment',
  'lesson_observation',
  'parent_communication',
  'learning_state',
  'homework',
  'goal',
  'achievement',
  'concern',
  'agreement',
  'follow_up',
  'general_note',
];

export const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
export const VISIBILITIES: Visibility[] = ['internal_only', 'parent_shareable', 'needs_review'];
export const IMPORTANCES: Importance[] = ['normal', 'important', 'critical'];

// 带时区 RFC3339 时间字符串（例如 2024-01-01T00:00:00.000Z / +08:00）
const RFC3339_TZ_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && (SOURCE_TYPES as string[]).includes(value);
}

function parseOptionalTzDate(
  value: unknown,
  field: string,
): Result<Date | undefined, CommonError> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: validationError(`${field} 必须是带时区的 RFC3339 时间字符串`, field),
    };
  }
  const trimmed = value.trim();
  if (!RFC3339_TZ_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    return { ok: false, error: validationError(`${field} 必须是带时区的 RFC3339 时间`, field) };
  }
  return { ok: true, value: new Date(trimmed) };
}

async function parseOccurredAt(
  clock: TrustedClock,
  value: unknown,
  field: string,
): Promise<Result<Date, CommonError>> {
  const parsed = parseOptionalTzDate(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value !== undefined) return { ok: true, value: parsed.value };
  return clock.now();
}

type StudentRecordsToolsClientProvider = PrismaClient | { getClient: () => Promise<PrismaClient> };

function studentRecordsToolsGetClient(provider: StudentRecordsToolsClientProvider): () => Promise<PrismaClient> {
  return typeof provider === 'object'
    && provider !== null
    && typeof (provider as { getClient?: unknown }).getClient === 'function'
    ? (provider as { getClient: () => Promise<PrismaClient> }).getClient
    : async () => provider as PrismaClient;
}

export function registerStudentRecordsTools(
  registry: ToolRegistry,
  prismaOrGetClient: StudentRecordsToolsClientProvider,
  trustedClock?: TrustedClock,
  options?: {
    captureCommunicationFromText?: CaptureCommunicationFromTextUseCase;
  },
): void {
  const getClient = studentRecordsToolsGetClient(prismaOrGetClient);
  const trustedClock2 = trustedClock ?? createDatabaseTrustedClock(prismaOrGetClient as PrismaClient);
  const sources = createStudentSourceRecordService({ getClient });
  const assessments = createAssessmentService({ getClient });
  const captureCommunicationFromText = options?.captureCommunicationFromText;

  // students.sources.ingest：录入一条学生原始证据
  registry.register(
    {
      name: 'students.sources.ingest',
      description:
        '录入一条学生原始证据（agent 文本、手工、课程、成绩、音视频、图片、截图或导入），未指定学生时标记为待归属',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID，可选；缺省视为待归属证据' },
          sourceType: {
            type: 'string',
            enum: SOURCE_TYPES,
            description: '来源类型：agent_text/manual/lesson/assessment/audio/image/screenshot/import',
          },
          sourceEntityType: { type: 'string', description: '来源实体类型，可选' },
          sourceEntityId: { type: 'string', description: '来源实体 ID，可选' },
          rawText: { type: 'string', description: '原始文本' },
          occurredAt: { type: 'string', description: '发生时间（带 Z/offset 的 RFC3339），可选' },
        },
        required: ['sourceType', 'rawText'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (!isSourceType(a.sourceType)) {
        return { ok: false, error: validationError('sourceType 必须是合法来源类型', 'sourceType') };
      }
      if (typeof a.rawText !== 'string' || a.rawText.trim() === '') {
        return { ok: false, error: validationError('rawText 必须是非空字符串', 'rawText') };
      }
      if (a.studentId !== undefined && (typeof a.studentId !== 'string' || a.studentId.trim() === '')) {
        return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
      }
      if (a.sourceEntityType !== undefined && typeof a.sourceEntityType !== 'string') {
        return { ok: false, error: validationError('sourceEntityType 必须是字符串', 'sourceEntityType') };
      }
      if (a.sourceEntityId !== undefined && typeof a.sourceEntityId !== 'string') {
        return { ok: false, error: validationError('sourceEntityId 必须是字符串', 'sourceEntityId') };
      }

      const occurredAtResult = await parseOccurredAt(trustedClock2, a.occurredAt, 'occurredAt');
      if (!occurredAtResult.ok) return occurredAtResult;

      return sources.captureSource({
        teacherId: context.teacherId,
        studentId: typeof a.studentId === 'string' ? a.studentId : undefined,
        sourceType: a.sourceType,
        sourceEntityType: typeof a.sourceEntityType === 'string' ? a.sourceEntityType : undefined,
        sourceEntityId: typeof a.sourceEntityId === 'string' ? a.sourceEntityId : undefined,
        rawText: a.rawText,
        occurredAt: occurredAtResult.value,
      });
    },
  );

  // students.records.capture：P29-W1 已升级为可信确认（confirmation:'required'）。
  // Agent 工具调用不再直接执行：必须经 ConfirmationGateway 创建 PendingAction，
  // 用户确认后由 records-capture executor 在同一事务内复检归属+版本 CAS 再落库。
  // 此处 handler 固定 fail-closed，防止任何直通执行路径绕过确认。
  registry.register(
    {
      name: 'students.records.capture',
      description:
        '为学生长期资料库创建一条时间线记录；提供 sourceText 时会先录入一条 agent_text 原始证据并关联到该记录',
      sideEffect: 'create',
      confirmation: 'required',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
          category: {
            type: 'string',
            enum: CATEGORIES,
            description:
              '记录类别：assessment/lesson_observation/parent_communication/learning_state/homework/goal/achievement/concern/agreement/follow_up/general_note',
          },
          summary: { type: 'string', description: '事实摘要' },
          occurredAt: { type: 'string', description: '发生时间（带 Z/offset 的 RFC3339），可选' },
          sourceText: { type: 'string', description: '原始文本，可选' },
          sourceEntityType: { type: 'string', description: '来源实体类型，可选' },
          sourceEntityId: { type: 'string', description: '来源实体 ID，可选' },
          confidence: { type: 'string', enum: CONFIDENCES, description: '置信度：high/medium/low' },
          visibility: {
            type: 'string',
            enum: VISIBILITIES,
            description: '可见性：internal_only/parent_shareable/needs_review',
          },
          importance: { type: 'string', enum: IMPORTANCES, description: '重要性：normal/important/critical' },
        },
        required: ['studentId', 'category', 'summary'],
        additionalProperties: false,
      },
    },
    async (_args, _context) => {
      return {
        ok: false,
        error: validationError('该工具必须通过 ConfirmationGateway 创建待确认操作', 'confirmation'),
      };
    },
  );

  // students.assessments.create：创建一条成绩记录（长期资料库记录 + 成绩明细）
  registry.register(
    {
      name: 'students.assessments.create',
      description: '为学生创建一条成绩记录（长期资料库记录 + 成绩明细）',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
          examName: { type: 'string', description: '考试名称，可选' },
          subject: { type: 'string', description: '科目，可选' },
          score: { type: 'number', description: '分数（必须大于 0），可选' },
          fullScore: { type: 'number', description: '满分（必须大于 0），可选' },
          examDate: { type: 'string', description: '考试日期（带 Z/offset 的 RFC3339），可选' },
          note: { type: 'string', description: '备注，可选' },
          sourceText: { type: 'string', description: '原始文本，可选' },
          summaryOverride: { type: 'string', description: '摘要覆盖，可选' },
        },
        required: ['studentId'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.studentId !== 'string' || a.studentId.trim() === '') {
        return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
      }
      if (a.examName !== undefined && typeof a.examName !== 'string') {
        return { ok: false, error: validationError('examName 必须是字符串', 'examName') };
      }
      if (a.subject !== undefined && typeof a.subject !== 'string') {
        return { ok: false, error: validationError('subject 必须是字符串', 'subject') };
      }
      if (a.score !== undefined && (typeof a.score !== 'number' || a.score <= 0)) {
        return { ok: false, error: validationError('score 必须大于 0', 'score') };
      }
      if (a.fullScore !== undefined && (typeof a.fullScore !== 'number' || a.fullScore <= 0)) {
        return { ok: false, error: validationError('fullScore 必须大于 0', 'fullScore') };
      }
      if (a.note !== undefined && typeof a.note !== 'string') {
        return { ok: false, error: validationError('note 必须是字符串', 'note') };
      }
      if (a.sourceText !== undefined && typeof a.sourceText !== 'string') {
        return { ok: false, error: validationError('sourceText 必须是字符串', 'sourceText') };
      }
      if (a.summaryOverride !== undefined && typeof a.summaryOverride !== 'string') {
        return { ok: false, error: validationError('summaryOverride 必须是字符串', 'summaryOverride') };
      }

      const examDateResult = parseOptionalTzDate(a.examDate, 'examDate');
      if (!examDateResult.ok) return examDateResult;

      return assessments.createScoreRecord({
        teacherId: context.teacherId,
        studentId: a.studentId,
        examName: typeof a.examName === 'string' ? a.examName : undefined,
        subject: typeof a.subject === 'string' ? a.subject : undefined,
        score: typeof a.score === 'number' ? a.score : undefined,
        fullScore: typeof a.fullScore === 'number' ? a.fullScore : undefined,
        examDate: examDateResult.value,
        note: typeof a.note === 'string' ? a.note : undefined,
        sourceText: typeof a.sourceText === 'string' ? a.sourceText : undefined,
        summaryOverride: typeof a.summaryOverride === 'string' ? a.summaryOverride : undefined,
      });
    },
  );

  if (captureCommunicationFromText) {
    registry.register(
      {
        name: 'students.communications.capture',
        description: '从文本中提取家长沟通信息并创建沟通记录（自动识别方向/渠道/家长类型/诉求/回应/共识/待办）',
        sideEffect: 'create',
        parameters: {
          type: 'object',
          properties: {
            studentId: { type: 'string', description: '学生 ID' },
            rawText: { type: 'string', description: '沟通原始文本（必须非空）' },
            occurredAt: { type: 'string', description: '发生时间（带 Z/offset 的 RFC3339），可选' },
          },
          required: ['studentId', 'rawText'],
        },
      },
      async (args, context) => {
        const a = args as Record<string, unknown>;

        if (typeof a.studentId !== 'string' || a.studentId.trim() === '') {
          return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
        }
        if (typeof a.rawText !== 'string' || a.rawText.trim() === '') {
          return { ok: false, error: validationError('rawText 必须是非空字符串', 'rawText') };
        }

        const occurredAtResult = parseOptionalTzDate(a.occurredAt, 'occurredAt');
        if (!occurredAtResult.ok) return occurredAtResult;

        return captureCommunicationFromText.execute({
          teacherId: context.teacherId,
          studentId: a.studentId,
          rawText: a.rawText,
          occurredAt: occurredAtResult.value,
        });
      },
    );
  }
}
