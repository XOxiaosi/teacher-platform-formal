import { err, ok, notFound, permissionDenied, validationError, internalError } from '@teacher-platform/contracts';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import { createConversationQueryService } from './conversation-query-service.js';
import type {
  ConversationService,
  ConversationData,
  ConversationTurnData,
  ConversationContextMessage,
  CreateConversationServiceOptions,
} from './types.js';

/** P8 phase-3 批3：ConversationTurn toolCalls/toolResults 经 encryptJsonFieldValue 加密后落库。 */

function toContextMessage(
  turn: {
    role: string;
    content: string;
    toolCalls: unknown;
    toolResults: unknown;
  },
  cipher: FieldCipher | undefined,
): ConversationContextMessage {
  const msg: ConversationContextMessage = {
    role: turn.role as ConversationContextMessage['role'],
    content: decryptFieldValue(cipher, turn.content),
  };
  if (turn.toolCalls) {
    msg.toolCalls = decryptJsonFieldValue(cipher, turn.toolCalls);
  }
  // 先解密 toolResults 再做 toolCallId 提取（密文字符串下 typeof 检查需在解密后）
  const toolResults = decryptJsonFieldValue(cipher, turn.toolResults);
  if (
    turn.role === 'tool'
    && typeof toolResults === 'object'
    && toolResults !== null
    && !Array.isArray(toolResults)
    && typeof (toolResults as Record<string, unknown>).toolCallId === 'string'
  ) {
    msg.toolCallId = (toolResults as Record<string, unknown>).toolCallId as string;
  }
  return msg;
}

function toConversationData(record: {
  id: string;
  teacherId: string;
  status: string;
  summary: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}): ConversationData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    status: record.status as ConversationData['status'],
    summary: record.summary,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

function toConversationTurnData(
  record: {
    id: string;
    conversationId: string;
    teacherId: string;
    role: string;
    content: string;
    toolCalls: unknown;
    toolResults: unknown;
    audioFileRef: string | null;
    createdAtTs: Date;
  },
  cipher: FieldCipher | undefined,
): ConversationTurnData {
  return {
    id: record.id,
    conversationId: record.conversationId,
    teacherId: record.teacherId,
    role: record.role as ConversationTurnData['role'],
    content: decryptFieldValue(cipher, record.content),
    toolCalls: decryptJsonFieldValue(cipher, record.toolCalls),
    toolResults: decryptJsonFieldValue(cipher, record.toolResults),
    audioFileRef: record.audioFileRef,
    createdAt: record.createdAtTs,
  };
}

export function createConversationService(options: CreateConversationServiceOptions): ConversationService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批3：ConversationTurn 字段加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const queryService = createConversationQueryService({ ...options, cipher });

  async function resolve(): Promise<{ prisma: PrismaClient | Prisma.TransactionClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    ...queryService,
    async createConversation(input) {
      const { prisma, trustedClock } = await resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const conversation = await prisma.conversation.create({
        data: {
          teacherId: input.teacherId,
          status: 'active',
          summary: null,
          createdAtTs: now.value,
          updatedAtTs: now.value,
        },
      });

      return ok(toConversationData(conversation));
    },

    async getConversation(input) {
      const { prisma } = await resolve();
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }

      if (conversation.teacherId !== input.teacherId) {
        return err(permissionDenied('无权访问该会话'));
      }

      return ok(toConversationData(conversation));
    },

    async appendTurn(input) {
      const { prisma, trustedClock } = await resolve();
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }

      if (conversation.teacherId !== input.teacherId) {
        return err(permissionDenied('无权访问该会话'));
      }

      if (conversation.status !== 'active') {
        return err(validationError('已归档的会话不能追加轮次', 'status'));
      }
      if (conversation.runtimeOwner && conversation.runtimeOwner !== 'legacy') {
        return err(validationError('新版任务消息必须通过教学任务入口保存', 'runtimeOwner'));
      }

      const VALID_ROLES = ['user', 'assistant', 'tool', 'error'];
      if (!VALID_ROLES.includes(input.role)) {
        return err(validationError('非法角色类型', 'role'));
      }

      if (!input.content || input.content.trim() === '') {
        return err(validationError('内容不能为空', 'content'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const turn = await prisma.conversationTurn.create({
          data: {
            conversationId: input.conversationId,
            teacherId: input.teacherId,
            role: input.role,
            content: encryptFieldValue(cipher, input.content),
            toolCalls: input.toolCalls === undefined || input.toolCalls === null
              ? Prisma.JsonNull
              : (encryptJsonFieldValue(cipher, input.toolCalls) as unknown as Prisma.InputJsonValue),
            toolResults: input.toolResults === undefined || input.toolResults === null
              ? Prisma.JsonNull
              : (encryptJsonFieldValue(cipher, input.toolResults) as unknown as Prisma.InputJsonValue),
            audioFileRef: input.audioFileRef ?? null,
            createdAtTs: now.value,
          },
        });

        return ok(toConversationTurnData(turn, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`追加对话轮次失败：${message}`));
      }
    },

    async listTurns(input) {
      const { prisma } = await resolve();
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }

      if (conversation.teacherId !== input.teacherId) {
        return err(permissionDenied('无权访问该会话'));
      }

      const turns = await prisma.conversationTurn.findMany({
        where: { conversationId: input.conversationId },
        orderBy: { createdAtTs: 'asc' },
        ...(input.limit !== undefined && { take: input.limit }),
      });

      try {
        return ok(turns.map((turn) => toConversationTurnData(turn, cipher)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询对话轮次失败：${message}`));
      }
    },

    async buildContext(input) {
      const { prisma } = await resolve();
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }
      if (conversation.runtimeOwner && conversation.runtimeOwner !== 'legacy') {
        return err(validationError('新版任务上下文不能交给旧助手', 'runtimeOwner'));
      }

      if (conversation.teacherId !== input.teacherId) {
        return err(permissionDenied('无权访问该会话'));
      }

      if (input.maxTurns !== undefined && input.maxTurns <= 0) {
        return err(validationError('maxTurns 必须大于 0', 'maxTurns'));
      }

      let turns = await prisma.conversationTurn.findMany({
        where: { conversationId: input.conversationId },
        orderBy: { createdAtTs: 'asc' },
      });

      const shouldTruncate = input.maxTurns !== undefined && turns.length > input.maxTurns;

      if (shouldTruncate) {
        turns = turns.slice(turns.length - input.maxTurns!);
      }

      try {
        const messages: ConversationContextMessage[] = turns
          .filter((turn) => turn.role !== 'error')
          .map((turn) => toContextMessage(turn, cipher));

        // 截断且有 summary 时，在最前面 prepend system 消息
        if (shouldTruncate && conversation.summary) {
          messages.unshift({
            role: 'system',
            content: `会话摘要：${conversation.summary}`,
          });
        }

        return ok(messages);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`组装对话上下文失败：${message}`));
      }
    },

    async archiveConversation(input) {
      const { prisma, trustedClock } = await resolve();
      const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, teacherId: input.teacherId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }

      // 幂等：已 archived 再 archive 直接返回当前状态
      if (conversation.status === 'archived') {
        return ok(toConversationData(conversation));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updated = await prisma.conversation.update({
        where: { id: input.conversationId },
        data: { status: 'archived', updatedAtTs: now.value },
      });

      return ok(toConversationData(updated));
    },

    async updateSummary(input) {
      const { prisma, trustedClock } = await resolve();
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation) {
        return err(notFound('会话不存在'));
      }
      if (conversation.runtimeOwner && conversation.runtimeOwner !== 'legacy') {
        return err(validationError('新版任务不能通过旧入口更新摘要', 'runtimeOwner'));
      }

      if (conversation.teacherId !== input.teacherId) {
        return err(permissionDenied('无权访问该会话'));
      }

      if (!input.summary || input.summary.trim() === '') {
        return err(validationError('摘要不能为空', 'summary'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updated = await prisma.conversation.update({
        where: { id: input.conversationId },
        data: { summary: input.summary, updatedAtTs: now.value },
      });

      return ok(toConversationData(updated));
    },
  };
}
