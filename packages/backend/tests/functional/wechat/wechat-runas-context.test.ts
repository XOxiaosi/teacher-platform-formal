import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createRunInTeacherContext } from '../../../src/app/composition/wechat-assembly.js';
import {
  currentTeacherId,
  createRoutingAiClient,
  runAsTeacher,
} from '../../../src/shared/ai-client/index.js';
import { getRequestDb } from '../../../src/shared/database-pool/index.js';
import { createWechatAgentLoop } from '../../../src/features/wechat/index.js';
import type { NormalizedInboundMessage } from '../../../src/features/wechat/index.js';

/**
 * P1 修复回归（qa3 t26）：wechat worker 缺 runAsTeacher 上下文 → provider 路由失效。
 *
 * 根因：runInTeacherContext 只包 runWithRequestDb（教师库 DB 路由），未包 runAsTeacher——
 * routing-ai-client 的 currentTeacherId() 恒 '' → 永远回退默认 provider（教师自定义 ProviderConfig 失效）。
 * 修复：runWithRequestDb 内嵌套 runAsTeacher（与 HTTP coreGuard 顺序一致，双 ALS 并存）。
 *
 * 测试：
 * 1. 池形态 runInTeacherContext：currentTeacherId 正确 + 教师库 DB 上下文并存；
 * 2. 单库透传形态（agent loop 路径）：currentTeacherId 正确（provider 路由不再回退默认）；
 * 3. routing client：runAsTeacher 上下文中 resolve 收到真实 teacherId（provider 路由端到端）。
 */

const prisma = new PrismaClient();
const createdTeacherIds: string[] = [];

afterAll(async () => {
  await prisma.sessionStore.deleteMany({ where: { teacherId: { in: createdTeacherIds } } });
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: createdTeacherIds } } });
  await prisma.$disconnect();
});

async function createTeacher(): Promise<string> {
  const teacher = await prisma.teacherRegistry.create({
    data: {
      email: `wx-ctx-${randomBytes(6).toString('hex')}@example.com`,
      passwordHash: 'scrypt$test$test',
      displayName: '上下文测试教师',
      databaseName: 'teacher_db_context_test',
    },
  });
  createdTeacherIds.push(teacher.id);
  return teacher.id;
}

function message(externalMessageId: string, from: string): NormalizedInboundMessage {
  return {
    channel: 'wechat',
    externalMessageId,
    fromExternalUserId: from,
    conversationType: 'private',
    messageType: 'text',
    text: 'hi',
  };
}

describe('runInTeacherContext（池形态）：runAsTeacher + runWithRequestDb 并存', () => {
  it('worker 内 currentTeacherId 正确 + 教师库 DB 上下文正确（provider 路由不再回退默认）', async () => {
    const teacherId = await createTeacher();
    const pool = {
      acquire: vi.fn(async () => prisma),
      release: vi.fn(),
    };
    const runInTeacherContext = createRunInTeacherContext(pool as never, prisma);

    let seenTeacherId: string | null = null;
    let seenDbName: string | null = null;
    await runInTeacherContext(teacherId, async () => {
      seenTeacherId = currentTeacherId();
      seenDbName = getRequestDb()?.dbName ?? null;
      return undefined;
    });

    expect(seenTeacherId).toBe(teacherId); // runAsTeacher 上下文（修复点）
    expect(seenDbName).toBe('teacher_db_context_test'); // runWithRequestDb 上下文（教师库路由）
    expect(pool.release).toHaveBeenCalledWith('teacher_db_context_test');
  });
});

describe('agent loop 单库透传路径（createWechatFeature 单库形态同款）', () => {
  it('agentConverse 执行时 currentTeacherId 正确（微信渠道 provider 路由）', async () => {
    let seenTeacherId: string | null = null;
    const agentConverse = {
      execute: vi.fn(async (input: { teacherId: string; conversationId: string }) => {
        seenTeacherId = currentTeacherId(); // routing-ai-client 同款读取
        return ok({ conversationId: input.conversationId, reply: 'ok' });
      }),
    };
    const loop = createWechatAgentLoop({
      agentConverse: agentConverse as never,
      conversationResolver: { resolveForMessage: vi.fn(async () => ok('conv-1')) },
      // 单库透传形态（wechat-assembly 缺省）：runAsTeacher 包裹
      runInTeacherContext: (teacherId, fn) => runAsTeacher(teacherId, () => fn()),
    });

    await loop.execute({ teacherId: 'teacher-wechat-1', message: message('m1', 'wx-1'), botId: 'bot-1' });
    expect(seenTeacherId).toBe('teacher-wechat-1');
  });
});

describe('routing client：runAsTeacher 上下文驱动 provider 路由', () => {
  it('chat 时 resolver.resolve 收到真实 teacherId（微信 worker 不再走默认 provider）', async () => {
    const provider = {
      async chat() {
        return ok({ content: 'ok', toolCalls: [] });
      },
    };
    const resolver = {
      resolve: vi.fn(async () => ({ provider, isDefault: true })),
    };
    const client = createRoutingAiClient({
      defaultProvider: provider as never,
      resolver: resolver as never,
    });

    await runAsTeacher('teacher-provider-1', async () => {
      const result = await client.chat(
        [{ role: 'user', content: 'hi' }],
        [],
      );
      expect(result.ok).toBe(true);
    });
    // 修复点：runAsTeacher 上下文使 currentTeacherId 非空 → resolver 收到真实 teacherId
    expect(resolver.resolve).toHaveBeenCalledWith('teacher-provider-1');
  });

  it('无 runAsTeacher 上下文 → currentTeacherId 空 → 直接回退默认（对照：此即修复前 bug 行为）', async () => {
    const provider = {
      async chat() {
        return ok({ content: 'ok', toolCalls: [] });
      },
    };
    const resolver = {
      resolve: vi.fn(async () => ({ provider, isDefault: true })),
    };
    const client = createRoutingAiClient({
      defaultProvider: provider as never,
      resolver: resolver as never,
    });
    const result = await client.chat([{ role: 'user', content: 'hi' }], []);
    expect(result.ok).toBe(true); // 默认 provider 可用
    // 无上下文 → currentTeacherId '' → resolve 被短路（教师 ProviderConfig 不被解析）——
    // 修复前 wechat worker 即此状态（教师自定义 provider 失效）；修复后 runAsTeacher 使该路径不再发生
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
