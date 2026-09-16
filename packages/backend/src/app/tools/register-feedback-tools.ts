import type { PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import { getRequestDb } from '../../shared/database-pool/index.js';
import { createFeedbackService } from '../../features/feedback/index.js';
import type { FeedbackStatus } from '../../features/feedback/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import type { Logger } from '../../shared/logger/index.js';
import { parsePageArg } from './tool-arg-parsers.js';

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

export function registerFeedbackTools(
  registry: ToolRegistry,
  prisma: PrismaClient,
  trustedClock: TrustedClock,
  options?: { moderation?: ModerationAdapter; logger?: Logger },
): void {
  // S3 平移：请求期解析 client（databaseRouter 经 ALS 注入）；无请求上下文时回退装配期 prisma
  const feedback = createFeedbackService({
    prisma,
    trustedClock,
    getClient: async () => getRequestDb()?.client ?? prisma,
    moderation: options?.moderation?.provider === 'local' ? options.moderation : undefined,
    logger: options?.logger,
  });

  // feedback.create：创建家长反馈草稿
  registry.register(
    {
      name: 'feedback.create',
      description: '创建家长反馈草稿',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
          clientRequestId: { type: 'string', description: '可选的租户内幂等请求编号（1-128 字符）' },
          lessonId: { type: 'string', description: '关联课程 ID，可选' },
          title: { type: 'string', description: '反馈标题' },
          content: { type: 'string', description: '反馈内容' },
          channel: { type: 'string', description: '沟通渠道，例如 wechat/phone/offline/other' },
          parentName: { type: 'string', description: '家长称呼' },
          evidence: {
            type: 'array',
            description: '已确认且可用于家长材料的正式记录引用（按顺序）；事实内容由服务器重新读取',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '正式 StudentRecord ID，必填' },
                type: { type: 'string', enum: ['assessment', 'record'], description: '正式依据类型：assessment/record' },
                sourceVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '生成依据返回的版本；如有须原样传回，变更后需重新生成' },
                occurredAt: { type: 'string', description: '发生时间（带时区的 RFC3339）' },
                category: { type: 'string', description: '分类' },
                summary: { type: 'string', description: '摘要' },
                examName: { type: 'string', description: '考试名称' },
                subject: { type: 'string', description: '科目' },
                score: { type: 'number', description: '分数' },
                fullScore: { type: 'number', description: '满分' },
                previousScore: { type: 'number', description: '上次分数' },
                parentConcerns: { type: 'array', items: { type: 'string' }, description: '家长关注点' },
                followUps: { type: 'array', items: { type: 'string' }, description: '后续待办' },
              },
              required: ['id', 'type', 'occurredAt'],
            },
          },
          windowStart: { type: 'string', description: '快照时间窗开始（RFC3339）' },
          windowEnd: { type: 'string', description: '快照时间窗结束（RFC3339）' },
        },
        required: ['studentId', 'title', 'content'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.studentId !== 'string' || a.studentId.trim() === '') {
        return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
      }
      if (typeof a.title !== 'string' || a.title.trim() === '') {
        return { ok: false, error: validationError('title 必须是非空字符串', 'title') };
      }
      if (typeof a.content !== 'string' || a.content.trim() === '') {
        return { ok: false, error: validationError('content 必须是非空字符串', 'content') };
      }
      if (a.clientRequestId !== undefined && a.clientRequestId !== null
        && (typeof a.clientRequestId !== 'string' || a.clientRequestId.trim() === '' || a.clientRequestId.length > 128)) {
        return { ok: false, error: validationError('clientRequestId 必须是 1-128 个字符的非空字符串', 'clientRequestId') };
      }

      const evidence = a.evidence;
      if (evidence !== undefined && evidence !== null && !Array.isArray(evidence)) {
        return { ok: false, error: validationError('evidence 必须是数组', 'evidence') };
      }

      const windowStart = a.windowStart;
      if (windowStart !== undefined && windowStart !== null && typeof windowStart !== 'string') {
        return { ok: false, error: validationError('windowStart 必须是字符串', 'windowStart') };
      }

      const windowEnd = a.windowEnd;
      if (windowEnd !== undefined && windowEnd !== null && typeof windowEnd !== 'string') {
        return { ok: false, error: validationError('windowEnd 必须是字符串', 'windowEnd') };
      }

      return feedback.createFeedback({
        teacherId: context.teacherId,
        clientRequestId: typeof a.clientRequestId === 'string' ? a.clientRequestId.trim() : undefined,
        studentId: a.studentId,
        lessonId: typeof a.lessonId === 'string' ? a.lessonId : undefined,
        title: a.title,
        content: a.content,
        channel: typeof a.channel === 'string' ? a.channel : undefined,
        parentName: typeof a.parentName === 'string' ? a.parentName : undefined,
        evidence: Array.isArray(evidence) ? evidence : undefined,
        windowStart: typeof windowStart === 'string' ? windowStart : undefined,
        windowEnd: typeof windowEnd === 'string' ? windowEnd : undefined,
      });
    },
  );

  // feedback.list：列出家长反馈
  registry.register(
    {
      name: 'feedback.list',
      description: '列出家长反馈',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID 过滤' },
          status: { type: 'string', description: '状态过滤：draft/reviewed/sent/archived' },
          page: { type: 'number', description: '页码' },
          pageSize: { type: 'number', description: '每页数量' },
        },
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;
      const page = parsePageArg(a.page);
      const pageSize = parsePageArg(a.pageSize);

      let status: FeedbackStatus | undefined;
      if (a.status !== undefined && a.status !== null) {
        if (!isFeedbackStatus(a.status)) {
          return { ok: false, error: validationError('status 必须是 draft/reviewed/sent/archived', 'status') };
        }
        status = a.status;
      }

      return feedback.listFeedbacks({
        teacherId: context.teacherId,
        studentId: typeof a.studentId === 'string' ? a.studentId : undefined,
        status,
        page,
        pageSize,
      });
    },
  );

  // feedback.updateStatus：更新家长反馈状态（P29-W1：仅经 ConfirmationGateway 待确认执行）
  registry.register(
    {
      name: 'feedback.updateStatus',
      description: '更新家长反馈状态',
      sideEffect: 'update',
      confirmation: 'required',
      parameters: {
        type: 'object',
        properties: {
          feedbackId: { type: 'string', description: '家长反馈 ID' },
          status: { type: 'string', description: '新状态：draft/reviewed/sent/archived' },
          sentAt: { type: 'string', description: '发送时间（带 Z/offset 的 RFC3339），status=sent 时可选' },
        },
        required: ['feedbackId', 'status'],
        additionalProperties: false,
      },
    },
    // P29-W1：直接执行固定 fail-closed，与 register-p0-state-tools.ts 的 confirmationRequired 模式一致。
    // 缺少 ConfirmationGateway 时绝不可回退直接调用 updateFeedbackStatus。
    async () => err(
      validationError('该工具必须通过 ConfirmationGateway 创建待确认操作', 'confirmation'),
    ),
  );
}
