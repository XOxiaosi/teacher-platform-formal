import type { PrismaClient } from '@prisma/client';
import { validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import { createMemoService } from '../../features/memos/index.js';
import type { MemoStatus } from '../../features/memos/types.js';
import { parseDateArg, parsePageArg } from './tool-arg-parsers.js';

function isMemoStatus(value: unknown): value is MemoStatus {
  return value === 'active' || value === 'done' || value === 'archived';
}

type MemoToolsClientProvider = PrismaClient | { getClient: () => Promise<PrismaClient> };

function memoToolsGetClient(provider: MemoToolsClientProvider): () => Promise<PrismaClient> {
  return typeof provider === 'object'
    && provider !== null
    && typeof (provider as { getClient?: unknown }).getClient === 'function'
    ? (provider as { getClient: () => Promise<PrismaClient> }).getClient
    : async () => provider as PrismaClient;
}

export function registerMemoTools(registry: ToolRegistry, prismaOrGetClient: MemoToolsClientProvider): void {
  const getClient = memoToolsGetClient(prismaOrGetClient);
  const memos = createMemoService({ prisma: prismaOrGetClient as PrismaClient, getClient });

  // memos.create：创建教师备忘
  registry.register(
    {
      name: 'memos.create',
      description: '创建教师备忘',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '备忘标题' },
          content: { type: 'string', description: '备忘内容' },
          dueAt: { type: 'string', description: '到期时间（ISO 8601）' },
          tags: { description: '标签（数组或对象）' },
          source: { type: 'string', description: '来源' },
        },
        required: ['title', 'content'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.title !== 'string' || a.title.trim() === '') {
        return { ok: false, error: validationError('title 必须是非空字符串', 'title') };
      }
      if (typeof a.content !== 'string' || a.content.trim() === '') {
        return { ok: false, error: validationError('content 必须是非空字符串', 'content') };
      }

      const dueAt = parseDateArg(a.dueAt);
      if (dueAt && typeof dueAt === 'object' && 'error' in dueAt) {
        return { ok: false, error: validationError('dueAt 格式无效', 'dueAt') };
      }

      return memos.createMemo({
        teacherId: context.teacherId,
        title: a.title,
        content: a.content,
        dueAt: dueAt instanceof Date ? dueAt : undefined,
        tags: a.tags,
        source: typeof a.source === 'string' ? a.source : undefined,
      });
    },
  );

  // memos.list：列出教师备忘
  registry.register(
    {
      name: 'memos.list',
      description: '列出教师备忘',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '状态过滤：active/done/archived' },
          dueBefore: { type: 'string', description: '到期时间上限（ISO 8601）' },
          page: { type: 'number', description: '页码' },
          pageSize: { type: 'number', description: '每页数量' },
        },
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      const dueBefore = parseDateArg(a.dueBefore);
      if (dueBefore && typeof dueBefore === 'object' && 'error' in dueBefore) {
        return { ok: false, error: validationError('dueBefore 格式无效', 'dueBefore') };
      }

      const page = parsePageArg(a.page);
      const pageSize = parsePageArg(a.pageSize);

      let status: MemoStatus | undefined;
      if (a.status !== undefined && a.status !== null) {
        if (!isMemoStatus(a.status)) {
          return { ok: false, error: validationError('status 必须是 active/done/archived', 'status') };
        }
        status = a.status;
      }

      return memos.listMemos({
        teacherId: context.teacherId,
        status,
        dueBefore: dueBefore instanceof Date ? dueBefore : undefined,
        page,
        pageSize,
      });
    },
  );

  // memos.updateStatus：更新教师备忘状态
  registry.register(
    {
      name: 'memos.updateStatus',
      description: '更新教师备忘状态',
      sideEffect: 'update',
      parameters: {
        type: 'object',
        properties: {
          memoId: { type: 'string', description: '备忘 ID' },
          status: { type: 'string', description: '新状态：active/done/archived' },
        },
        required: ['memoId', 'status'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.memoId !== 'string' || a.memoId.trim() === '') {
        return { ok: false, error: validationError('memoId 必须是非空字符串', 'memoId') };
      }

      if (!isMemoStatus(a.status)) {
        return { ok: false, error: validationError('status 必须是 active/done/archived', 'status') };
      }

      return memos.updateMemoStatus({
        teacherId: context.teacherId,
        memoId: a.memoId,
        status: a.status,
      });
    },
  );
}
