import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { notFound } from '@teacher-platform/contracts';
import { createActionTokenSigner } from '../../src/features/pending-action/action-token-signer.js';
import { createPendingActionService } from '../../src/features/pending-action/pending-action-service.js';
import type { ConversationOwnerPort } from '../../src/features/pending-action/types.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批5：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

const TEACHER_A = 'test-pending-action-teacher-a';
const TEACHER_B = 'test-pending-action-teacher-b';
const SECRET = 'test-action-token-secret-with-at-least-32-bytes';
const TTL_SECONDS = 600;

let database: IsolatedPostgres;
let prisma: PrismaClient;

function createConversationOwnerPort(): ConversationOwnerPort {
  return {
    async getOwnedConversation(input) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, teacherId: input.teacherId },
        select: { id: true, status: true },
      });
      return conversation
        ? { ok: true, value: { id: conversation.id, status: conversation.status } }
        : { ok: false, error: notFound('会话不存在') };
    },
  };
}

function createService(conversationOwner: ConversationOwnerPort = createConversationOwnerPort()) {
  return createPendingActionService({
    prisma,
    actionTokenSigner: createActionTokenSigner({ secret: SECRET }),
    conversationOwner,
    ttlSeconds: TTL_SECONDS,
  });
}

async function createConversation(teacherId = TEACHER_A) {
  return prisma.conversation.create({ data: { teacherId } });
}

function createInput(conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    teacherId: TEACHER_A,
    conversationId,
    toolCallId: 'tool-call-1',
    actionName: 'students.updateStatus' as const,
    target: { type: 'Student' as const, id: 'student-1' },
    parameters: { studentId: 'student-1', status: 'paused' },
    beforeSummary: '学生状态为 active',
    afterSummary: '将学生状态更新为 paused',
    ...overrides,
  };
}

async function databaseNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  return rows[0].now;
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.pendingAction.deleteMany();
  await prisma.conversation.deleteMany();
});

describe('PendingActionService.createPendingAction', () => {
  it('使用数据库可信时间计算 expiresAt，并返回可验证 token', async () => {
    const conversation = await createConversation();
    const before = await databaseNow();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('不得读取本机时间'); });

    const result = await createService().createPendingAction(createInput(conversation.id));

    dateNow.mockRestore();
    const after = await databaseNow();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingAction.status).toBe('pending');
    expect(result.value.pendingAction.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + TTL_SECONDS * 1000);
    expect(result.value.pendingAction.expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + TTL_SECONDS * 1000);
    expect(createActionTokenSigner({ secret: SECRET }).verify(result.value.actionToken)).toEqual({
      ok: true,
      value: { pendingActionId: result.value.pendingAction.id },
    });
  });

  it('创建时只写 createdAtTs/updatedAtTs/expiresAtTs，无旧列', async () => {
    const conversation = await createConversation();
    const result = await createService().createPendingAction(createInput(conversation.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const persisted = await prisma.pendingAction.findUniqueOrThrow({ where: { id: result.value.pendingAction.id } });
    expect(persisted.createdAtTs).toBeInstanceOf(Date);
    expect(persisted.updatedAtTs).toBeInstanceOf(Date);
    expect(persisted.expiresAtTs).toBeInstanceOf(Date);

    // 旧列已删除
    expect(persisted).not.toHaveProperty('createdAt');
    expect(persisted).not.toHaveProperty('updatedAt');
    expect(persisted).not.toHaveProperty('expiresAt');

    // createdAtTs 与 updatedAtTs 同源（同一个 trustedNow）
    expect(persisted.createdAtTs).toEqual(persisted.updatedAtTs);
    // expiresAtTs = trustedNow + TTL
    expect(persisted.expiresAtTs.getTime()).toBe(persisted.createdAtTs.getTime() + TTL_SECONDS * 1_000);
  });

  it('相同 teacherId + toolCallId 幂等返回同一记录与稳定 token', async () => {
    const conversation = await createConversation();
    const service = createService();

    const first = await service.createPendingAction(createInput(conversation.id));
    const second = await service.createPendingAction(createInput(conversation.id, {
      parameters: { status: 'paused', studentId: 'student-1' },
    }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.pendingAction.id).toBe(first.value.pendingAction.id);
    expect(second.value.actionToken).toBe(first.value.actionToken);
    expect(await prisma.pendingAction.count()).toBe(1);
  });

  it('并发创建相同幂等键只产生一条记录并返回同一 token', async () => {
    const conversation = await createConversation();
    const service = createService();

    const results = await Promise.all(Array.from({ length: 5 }, () => (
      service.createPendingAction(createInput(conversation.id))
    )));

    expect(results.every((result) => result.ok)).toBe(true);
    const successful = results.filter((result) => result.ok);
    expect(new Set(successful.map((result) => result.value.pendingAction.id)).size).toBe(1);
    expect(new Set(successful.map((result) => result.value.actionToken)).size).toBe(1);
    expect(await prisma.pendingAction.count()).toBe(1);
  });

  it('同一幂等键若动作参数变化则拒绝，不覆盖原记录', async () => {
    const conversation = await createConversation();
    const service = createService();
    await service.createPendingAction(createInput(conversation.id));

    const result = await service.createPendingAction(createInput(conversation.id, {
      parameters: { studentId: 'student-1', status: 'finished' },
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'toolCallId' },
    });
    expect(await prisma.pendingAction.count()).toBe(1);
    const persisted = await prisma.pendingAction.findFirstOrThrow();
    // P8 phase-3 批5：parameters 落库为密文，解密后断言
    expect(cipher.decryptJson<unknown>(persisted.parameters as unknown as string)).toEqual({ studentId: 'student-1', status: 'paused' });
  });

  it('通过 ConversationOwnerPort 校验 teacher，跨 teacher 返回 NOT_FOUND 且不创建记录', async () => {
    const conversation = await createConversation(TEACHER_B);
    const owner = createConversationOwnerPort();
    const spy = vi.spyOn(owner, 'getOwnedConversation');

    const result = await createService(owner).createPendingAction(createInput(conversation.id));

    expect(spy).toHaveBeenCalledWith({ teacherId: TEACHER_A, conversationId: conversation.id });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '会话不存在' } });
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('拒绝未知动作、空对象和越界 TTL', async () => {
    const conversation = await createConversation();

    const unknownAction = await createService().createPendingAction(createInput(conversation.id, {
      actionName: 'payments.delete',
    }) as never);
    const emptyTarget = await createService().createPendingAction(createInput(conversation.id, {
      target: { type: 'Student', id: '' },
    }));

    expect(unknownAction).toMatchObject({ ok: false, error: { field: 'actionName' } });
    expect(emptyTarget).toMatchObject({ ok: false, error: { field: 'targetId' } });
    expect(() => createPendingActionService({
      prisma,
      actionTokenSigner: createActionTokenSigner({ secret: SECRET }),
      conversationOwner: createConversationOwnerPort(),
      ttlSeconds: 0,
    })).toThrow('ttlSeconds 必须在 1 到 86400 之间');
  });
});

describe('PendingActionService.getPendingAction', () => {
  it('当前 teacher 可查询并重建稳定 token，跨 teacher 返回 NOT_FOUND', async () => {
    const conversation = await createConversation();
    const service = createService();
    const created = await service.createPendingAction(createInput(conversation.id));
    if (!created.ok) throw new Error(created.error.message);

    const own = await service.getPendingAction({
      pendingActionId: created.value.pendingAction.id,
      teacherId: TEACHER_A,
    });
    const crossTeacher = await service.getPendingAction({
      pendingActionId: created.value.pendingAction.id,
      teacherId: TEACHER_B,
    });

    expect(own).toEqual(created);
    expect(crossTeacher).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: '待确认操作不存在' },
    });
  });

  it('按当前页 toolCallIds 批量查询同 teacher、同 conversation 的 PendingAction', async () => {
    const conversation = await createConversation();
    const otherConversation = await createConversation();
    const service = createService();
    const first = await service.createPendingAction(createInput(conversation.id));
    const second = await service.createPendingAction(createInput(conversation.id, {
      toolCallId: 'tool-call-2',
      target: { type: 'Student', id: 'student-2' },
      parameters: { studentId: 'student-2', status: 'paused' },
    }));
    await service.createPendingAction(createInput(otherConversation.id, { toolCallId: 'tool-call-other' }));
    if (!first.ok || !second.ok) throw new Error('fixture creation failed');

    const result = await service.listForConversationToolCalls({
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      toolCallIds: ['tool-call-2', 'tool-call-1', 'missing'],
    });
    const crossTeacher = await service.listForConversationToolCalls({
      teacherId: TEACHER_B,
      conversationId: conversation.id,
      toolCallIds: ['tool-call-1'],
    });
    const empty = await service.listForConversationToolCalls({
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      toolCallIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((item) => item.pendingAction.toolCallId)).toEqual(['tool-call-1', 'tool-call-2']);
    expect(result.value.map((item) => item.actionToken)).toEqual([first.value.actionToken, second.value.actionToken]);
    expect(crossTeacher).toEqual({ ok: true, value: [] });
    expect(empty).toEqual({ ok: true, value: [] });
  });
});
