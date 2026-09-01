import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
  encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  AgentExecutionData,
  AgentExecutionService,
  AgentExecutionStage,
  AgentExecutionStatus,
  CreateAgentExecutionServiceOptions,
} from './types.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function fingerprint(conversationId: string, message: string): string {
  return createHash('sha256').update(JSON.stringify([conversationId, message]), 'utf8').digest('hex');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function commonError(value: unknown): AgentExecutionData['error'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
  return {
    code: record.code as AgentExecutionData['error'] extends infer E
      ? E extends { code: infer C } ? C : never
      : never,
    message: record.message,
    ...(typeof record.field === 'string' ? { field: record.field } : {}),
  };
}

function mapExecution(
  record: {
    id: string; teacherId: string; conversationId: string; clientRequestId: string;
    requestFingerprint: string; userTurnId: string | null; status: string; stage: string; reply: string | null;
    error: unknown; completedToolCallIds: unknown;
    startedAtTs: Date; finishedAtTs: Date | null; createdAtTs: Date; updatedAtTs: Date;
  },
  cipher: FieldCipher | undefined,
): AgentExecutionData {
  return {
    ...record,
    status: record.status as AgentExecutionStatus,
    stage: record.stage as AgentExecutionStage,
    // P8 phase-3 批5：reply 解密、error 解密后解析（双读：明文旧行直通）
    reply: record.reply === null ? null : decryptFieldValue(cipher, record.reply),
    error: commonError(decryptJsonFieldValue(cipher, record.error)),
    completedToolCallIds: stringArray(record.completedToolCallIds),
    // I8 定向切读：shadow 列持有 D48 契约转换后的正确绝对时刻，优先于旧列。
    // 旧列仅 AgentExecution.finishedAt/updatedAt 存在 6 行 LOS_ANGELES_WALL 错值。
    startedAt: record.startedAtTs,
    finishedAt: record.finishedAtTs,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function createAgentExecutionService(
  options: CreateAgentExecutionServiceOptions,
): AgentExecutionService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批3：ConversationTurn content/toolResults 跨服务写读加密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  async function owned(teacherId: string, executionId: string) {
    const prisma = await getClient();
    const record = await prisma.agentExecution.findFirst({ where: { id: executionId, teacherId } });
    return record ? ok(mapExecution(record, cipher)) : err(notFound('Agent 执行不存在'));
  }

  return {
    async claim(input) {
      const prisma = await getClient();
      const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(prisma);
      if (!REQUEST_ID.test(input.clientRequestId)) {
        return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      }
      if (!input.message.trim()) return err(validationError('消息不能为空', 'message'));
      const requestFingerprint = fingerprint(input.conversationId, input.message);

      const existing = await prisma.agentExecution.findUnique({
        where: { teacherId_clientRequestId: {
          teacherId: input.teacherId,
          clientRequestId: input.clientRequestId,
        } },
      });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return err(validationError('clientRequestId 已绑定其他请求', 'clientRequestId'));
        }
        return ok({ kind: 'existing' as const, execution: mapExecution(existing, cipher) });
      }

      const trustedNow = await trustedClock.now();
      if (!trustedNow.ok) return trustedNow;

      try {
        const execution = await prisma.$transaction(async (tx) => {
          const conversation = await tx.conversation.findFirst({
            where: { id: input.conversationId, teacherId: input.teacherId },
          });
          if (!conversation) throw new Error('AGENT_EXECUTION_CONVERSATION_NOT_FOUND');
          if (conversation.status !== 'active') throw new Error('AGENT_EXECUTION_CONVERSATION_ARCHIVED');
          const created = await tx.agentExecution.create({
            data: {
              teacherId: input.teacherId,
              conversationId: input.conversationId,
              clientRequestId: input.clientRequestId,
              requestFingerprint,
              completedToolCallIds: [],
              startedAtTs: trustedNow.value,
              createdAtTs: trustedNow.value,
              updatedAtTs: trustedNow.value,
            },
          });
          const userTurn = await tx.conversationTurn.create({
            data: {
              conversationId: input.conversationId,
              teacherId: input.teacherId,
              role: 'user',
              content: encryptFieldValue(cipher, input.message),
              createdAtTs: trustedNow.value,
            },
          });
          return tx.agentExecution.update({
            where: { id: created.id },
            data: { userTurnId: userTurn.id, updatedAtTs: trustedNow.value },
          });
        });
        return ok({ kind: 'claimed' as const, execution: mapExecution(execution, cipher) });
      } catch (caught) {
        if (caught instanceof Error && caught.message === 'AGENT_EXECUTION_CONVERSATION_NOT_FOUND') {
          return err(notFound('会话不存在'));
        }
        if (caught instanceof Error && caught.message === 'AGENT_EXECUTION_CONVERSATION_ARCHIVED') {
          return err(validationError('已归档的会话不能发送消息', 'status'));
        }
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          const raced = await prisma.agentExecution.findUnique({
            where: { teacherId_clientRequestId: {
              teacherId: input.teacherId,
              clientRequestId: input.clientRequestId,
            } },
          });
          if (raced && raced.requestFingerprint === requestFingerprint) {
            return ok({ kind: 'existing' as const, execution: mapExecution(raced, cipher) });
          }
          return err(validationError('clientRequestId 已绑定其他请求', 'clientRequestId'));
        }
        throw caught;
      }
    },

    async complete(input) {
      const prisma = await getClient();
      const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(prisma);
      const trustedNow = await trustedClock.now();
      if (!trustedNow.ok) return trustedNow;

      const updated = await prisma.$transaction(async (tx) => {
        const { count } = await tx.agentExecution.updateMany({
          where: { id: input.executionId, teacherId: input.teacherId, status: 'running' },
          data: {
            status: input.status,
            stage: input.stage,
            reply: input.reply === null ? null : encryptFieldValue(cipher, input.reply),
            completedToolCallIds: json(input.completedToolCallIds),
            finishedAtTs: trustedNow.value,
            updatedAtTs: trustedNow.value,
          },
        });
        if (count !== 1) return null;
        return tx.agentExecution.findUnique({ where: { id: input.executionId } });
      });
      return updated ? ok(mapExecution(updated, cipher)) : err(notFound('运行中的 Agent 执行不存在'));
    },

    async fail(input) {
      const prisma = await getClient();
      const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(prisma);
      const trustedNow = await trustedClock.now();
      if (!trustedNow.ok) return trustedNow;

      const updated = await prisma.$transaction(async (tx) => {
        const execution = await tx.agentExecution.findFirst({
          where: { id: input.executionId, teacherId: input.teacherId },
        });
        if (!execution) return null;
        const { count } = await tx.agentExecution.updateMany({
          where: { id: input.executionId, teacherId: input.teacherId, status: 'running' },
          data: {
            status: input.status,
            stage: input.stage,
            error: (encryptJsonFieldValue(cipher, input.error) as unknown) as Prisma.InputJsonValue,
            completedToolCallIds: json(input.completedToolCallIds),
            finishedAtTs: trustedNow.value,
            updatedAtTs: trustedNow.value,
          },
        });
        if (count !== 1) return null;
        await tx.conversationTurn.create({
          data: {
            conversationId: execution.conversationId,
            teacherId: input.teacherId,
            role: 'error',
            content: encryptFieldValue(cipher, input.error.message),
            createdAtTs: trustedNow.value,
            toolResults: (encryptJsonFieldValue(cipher, {
              executionId: execution.id,
              stage: input.stage,
              error: input.error,
              retryable: input.retryable,
              retryAction: input.retryAction,
              completedToolCallIds: input.completedToolCallIds,
            }) as unknown) as Prisma.InputJsonValue,
          },
        });
        return tx.agentExecution.findUnique({ where: { id: input.executionId } });
      });
      return updated ? ok(mapExecution(updated, cipher)) : err(notFound('运行中的 Agent 执行不存在'));
    },

    get(input) {
      return owned(input.teacherId, input.executionId);
    },

    async prepareReplay(input) {
      const prisma = await getClient();
      if (!REQUEST_ID.test(input.clientRequestId)) {
        return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      }
      const execution = await prisma.agentExecution.findFirst({
        where: { id: input.executionId, teacherId: input.teacherId },
      });
      if (!execution) return err(notFound('Agent 执行不存在'));
      if (execution.status !== 'failed' || !execution.userTurnId) {
        return err(validationError('该 Agent 执行不可回放', 'executionId'));
      }
      const errorTurn = await prisma.conversationTurn.findFirst({
        where: { conversationId: execution.conversationId, role: 'error' },
        orderBy: { createdAtTs: 'desc' },
      });
      const result = decryptJsonFieldValue(cipher, errorTurn?.toolResults);
      const retryAction = result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).retryAction
        : undefined;
      if (retryAction !== 'retry-model' && retryAction !== 'retry-tool' && retryAction !== 'resend-message') {
        return err(validationError('该 Agent 执行不可安全回放', 'executionId'));
      }
      const userTurn = await prisma.conversationTurn.findFirst({
        where: { id: execution.userTurnId, teacherId: input.teacherId, role: 'user' },
      });
      if (!userTurn) return err(notFound('原始用户消息不存在'));
      return ok({
        conversationId: execution.conversationId,
        message: decryptFieldValue(cipher, userTurn.content),
        clientRequestId: input.clientRequestId,
      });
    },
  };
}
