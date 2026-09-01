import { err, internalError, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { Prisma } from '@prisma/client';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  ConversationListPageData,
  ConversationProjectionData,
  ConversationService,
  ConversationTurnData,
  ConversationTurnsPageData,
  CreateConversationServiceOptions,
  GetConversationInput,
  ListConversationsInput,
  ListConversationTurnsPageInput,
} from './types.js';

type QueryService = Pick<
  ConversationService,
  'getConversationProjection' | 'listConversations' | 'listConversationTurnsPage'
>;

type ConversationRecord = Prisma.ConversationGetPayload<{
  include: { turns: { orderBy: { createdAtTs: 'asc' } } };
}>;

interface ConversationCursorPayload {
  version: 1;
  teacherId: string;
  status: string;
  sortKey: string;
  id: string;
}

function toTurnData(turn: ConversationRecord['turns'][number], cipher: FieldCipher | undefined): ConversationTurnData {
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    teacherId: turn.teacherId,
    role: turn.role as ConversationTurnData['role'],
    content: decryptFieldValue(cipher, turn.content),
    toolCalls: decryptJsonFieldValue(cipher, turn.toolCalls),
    toolResults: decryptJsonFieldValue(cipher, turn.toolResults),
    audioFileRef: turn.audioFileRef,
    createdAt: turn.createdAtTs,
  };
}

function toProjection(record: ConversationRecord, cipher: FieldCipher | undefined): ConversationProjectionData {
  const firstUser = record.turns.find((turn) => turn.role === 'user');
  const lastTurn = record.turns.at(-1);
  return {
    id: record.id,
    teacherId: record.teacherId,
    status: record.status as ConversationProjectionData['status'],
    summary: record.summary,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
    firstUserContent: firstUser ? decryptFieldValue(cipher, firstUser.content) : null,
    lastTurnContent: lastTurn ? decryptFieldValue(cipher, lastTurn.content) : null,
    lastTurnAt: lastTurn ? (lastTurn.createdAtTs) : null,
    turnCount: record.turns.length,
  };
}

function sortKey(item: ConversationProjectionData): string {
  return (item.lastTurnAt ?? item.createdAt).toISOString();
}

function encodeCursor(item: ConversationProjectionData, input: Required<Pick<ListConversationsInput, 'teacherId' | 'status'>>): string {
  const payload: ConversationCursorPayload = {
    version: 1,
    teacherId: input.teacherId,
    status: input.status,
    sortKey: sortKey(item),
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): ConversationCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ConversationCursorPayload>;
    if (
      parsed.version !== 1
      || typeof parsed.teacherId !== 'string'
      || typeof parsed.status !== 'string'
      || typeof parsed.sortKey !== 'string'
      || typeof parsed.id !== 'string'
    ) {
      return null;
    }
    return parsed as ConversationCursorPayload;
  } catch {
    return null;
  }
}

function normalizeLimit(limit: number | undefined, fallback: number) {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    return err(validationError('limit 必须是 1 到 50 的整数', 'limit'));
  }
  return ok(value);
}

function findCursorOffset(
  items: ConversationProjectionData[],
  cursor: string | undefined,
  teacherId: string,
  status: string,
) {
  if (!cursor) return ok(0);
  const payload = decodeCursor(cursor);
  if (!payload || payload.teacherId !== teacherId || payload.status !== status) {
    return err(validationError('cursor 无效或不适用于当前筛选条件', 'cursor'));
  }
  const index = items.findIndex((item) => item.id === payload.id && sortKey(item) === payload.sortKey);
  if (index < 0) return err(validationError('cursor 已失效', 'cursor'));
  return ok(index + 1);
}

export function createConversationQueryService(options: CreateConversationServiceOptions): QueryService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批3：ConversationTurn 读路径解密 cipher（缺省 env 构建）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async getConversationProjection(input: GetConversationInput) {
      const prisma = await getClient();
      const record = await prisma.conversation.findFirst({
        where: { id: input.conversationId, teacherId: input.teacherId },
        include: { turns: { orderBy: { createdAtTs: 'asc' } } },
      });
      if (!record) return err(notFound('会话不存在'));
      try {
        return ok(toProjection(record, cipher));
      } catch (e) {
        return err(internalError(`查询会话投影失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async listConversations(input: ListConversationsInput) {
      const prisma = await getClient();
      const status = input.status ?? 'active';
      if (status !== 'active' && status !== 'archived') {
        return err(validationError('会话状态不合法', 'status'));
      }
      const limit = normalizeLimit(input.limit, 20);
      if (!limit.ok) return limit;

      const records = await prisma.conversation.findMany({
        where: { teacherId: input.teacherId, status },
        include: { turns: { orderBy: { createdAtTs: 'asc' } } },
      });
      let sorted: ConversationProjectionData[];
      try {
        sorted = records.map((record) => toProjection(record, cipher)).sort((left, right) => {
          const byTime = sortKey(right).localeCompare(sortKey(left));
          return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
        });
      } catch (e) {
        return err(internalError(`查询会话列表失败：${e instanceof Error ? e.message : String(e)}`));
      }
      const offset = findCursorOffset(sorted, input.cursor, input.teacherId, status);
      if (!offset.ok) return offset;

      const pageItems = sorted.slice(offset.value, offset.value + limit.value);
      const hasNextPage = offset.value + pageItems.length < sorted.length;
      const data: ConversationListPageData = {
        items: pageItems,
        nextCursor: hasNextPage && pageItems.length > 0
          ? encodeCursor(pageItems.at(-1)!, { teacherId: input.teacherId, status })
          : null,
      };
      return ok(data);
    },

    async listConversationTurnsPage(input: ListConversationTurnsPageInput) {
      const prisma = await getClient();
      const owner = await prisma.conversation.findFirst({
        where: { id: input.conversationId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!owner) return err(notFound('会话不存在'));

      const limit = normalizeLimit(input.limit, 50);
      if (!limit.ok) return limit;

      let beforeTurn: { id: string; createdAtTs: Date } | null = null;
      if (input.before) {
        beforeTurn = await prisma.conversationTurn.findFirst({
          where: { id: input.before, conversationId: input.conversationId, teacherId: input.teacherId },
          select: { id: true, createdAtTs: true },
        });
        if (!beforeTurn) return err(validationError('before cursor 无效', 'before'));
      }

      const turns = await prisma.conversationTurn.findMany({
        where: {
          conversationId: input.conversationId,
          teacherId: input.teacherId,
          ...(beforeTurn && {
            OR: [
              { createdAtTs: { lt: beforeTurn.createdAtTs } },
              { createdAtTs: beforeTurn.createdAtTs, id: { lt: beforeTurn.id } },
            ],
          }),
        },
        orderBy: [{ createdAtTs: 'desc' }, { id: 'desc' }],
        take: limit.value + 1,
      });
      const hasPreviousPage = turns.length > limit.value;
      let items: ConversationTurnData[];
      try {
        items = turns.slice(0, limit.value).reverse().map((turn) => toTurnData(turn, cipher));
      } catch (e) {
        return err(internalError(`查询对话轮次失败：${e instanceof Error ? e.message : String(e)}`));
      }
      const data: ConversationTurnsPageData = {
        items,
        previousCursor: hasPreviousPage && items.length > 0 ? items[0].id : null,
      };
      return ok(data);
    },
  };
}
