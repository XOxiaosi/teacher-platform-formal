import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createConversationService } from '../../../src/features/conversation/index.js';
import { createAiNoteService } from '../../../src/features/ai-notes/index.js';
import { createAgentExecutionService } from '../../../src/features/agent-execution/index.js';
import { createStorage } from '../../../src/shared/storage/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P8 phase-3 加密落位批3（t17）：ConversationTurn（content/toolCalls/toolResults）+ AINote（rawInput/extractedData）。
 * - setup 已注入测试 ENCRYPTION_KEY → 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 不变 / 缺钥 SAFETY_BLOCK / 跨服务写读（agent-execution）。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64);

const TEACHER_A = `teacher_enc3_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc3_b_${randomBytes(4).toString('hex')}`;

let conversationService: ReturnType<typeof createConversationService>;
let aiNoteService: ReturnType<typeof createAiNoteService>;
let agentExecutionService: ReturnType<typeof createAgentExecutionService>;
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'enc3-'));
  const mockAiClient = {
    run: vi.fn(async () => ok({ intent: 'general_note', confidenceScore: 0.9, data: {} })),
  } as never;
  aiNoteService = createAiNoteService({
    prisma,
    aiClient: mockAiClient,
    storage: createStorage({ rootDir: tempRoot }),
  });
  conversationService = createConversationService({ prisma });
  agentExecutionService = createAgentExecutionService({ prisma });
});

afterAll(async () => {
  // FK 顺序：aINote（无引用）→ agentExecution(conversationId) → conversationTurn(conversationId) → conversation
  await prisma.aINote.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.$disconnect();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function createConversation(teacherId: string) {
  const created = await conversationService.createConversation({ teacherId });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe('批3 ConversationTurn：content/toolCalls/toolResults 加密往返', () => {
  it('appendTurn → DB 密文，listTurns/buildContext 解密明文', async () => {
    const conv = await createConversation(TEACHER_A);
    const toolCalls = [{ id: 'tc-1', name: 'students.get', args: { id: 's1' } }];
    const toolResults = { toolCallId: 'tc-1', rows: [{ id: 's1', name: '张三' }] };

    const appended = await conversationService.appendTurn({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      role: 'tool',
      content: '查询结果：张三',
      toolCalls,
      toolResults,
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.value.content).toBe('查询结果：张三');
    expect(appended.value.toolCalls).toEqual(toolCalls);
    expect(appended.value.toolResults).toEqual(toolResults);

    // DB 是密文
    const row = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: appended.value.id } });
    expect(row.content).not.toBe('查询结果：张三');
    expect(row.content.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(row.content)).toBe('查询结果：张三');
    expect(cipher.decryptJson<unknown>(row.toolCalls as unknown as string)).toEqual(toolCalls);
    expect(cipher.decryptJson<unknown>(row.toolResults as unknown as string)).toEqual(toolResults);

    // 读路径解密
    const list = await conversationService.listTurns({ conversationId: conv.id, teacherId: TEACHER_A });
    expect(list.ok && list.value[0].content).toBe('查询结果：张三');
    expect(list.ok && list.value[0].toolCalls).toEqual(toolCalls);
    expect(list.ok && list.value[0].toolResults).toEqual(toolResults);

    const context = await conversationService.buildContext({ conversationId: conv.id, teacherId: TEACHER_A });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value[0].content).toBe('查询结果：张三');
    expect(context.value[0].toolCallId).toBe('tc-1');
  });

  it('旧明文双读：prisma 直插明文 turn → 服务读直通', async () => {
    const conv = await createConversation(TEACHER_A);
    await prisma.conversationTurn.create({
      data: {
        conversationId: conv.id,
        teacherId: TEACHER_A,
        role: 'user',
        content: '旧明文轮次',
        toolCalls: [{ id: 'legacy-1' }],
        createdAtTs: new Date(),
      },
    });
    const list = await conversationService.listTurns({ conversationId: conv.id, teacherId: TEACHER_A });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const legacy = list.value.find((turn) => turn.content === '旧明文轮次');
    expect(legacy).toBeDefined();
    expect(legacy?.toolCalls).toEqual([{ id: 'legacy-1' }]);
  });

  it('owner 隔离不变：跨教师 listTurns/buildContext 仍 PERMISSION_DENIED', async () => {
    const conv = await createConversation(TEACHER_A);
    const crossed = await conversationService.listTurns({ conversationId: conv.id, teacherId: TEACHER_B });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('批3 AINote：rawInput/extractedData 加密往返', () => {
  it('saveNote → DB 密文，返回响应解密明文', async () => {
    const saved = await aiNoteService.saveNote({
      teacherId: TEACHER_A,
      inputType: 'text',
      rawInput: '明天下午三点给张三上课',
      extractedData: { studentName: '张三', timeText: '明天下午三点' },
      status: 'processed',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.rawInput).toBe('明天下午三点给张三上课');
    expect(saved.value.extractedData).toMatchObject({ studentName: '张三', timeText: '明天下午三点' });

    const row = await prisma.aINote.findUniqueOrThrow({ where: { id: saved.value.id } });
    expect(row.rawInput).not.toBe('明天下午三点给张三上课');
    expect(cipher.decrypt(row.rawInput)).toBe('明天下午三点给张三上课');
    expect(cipher.decryptJson<unknown>(row.extractedData as unknown as string)).toMatchObject({
      studentName: '张三',
      timeText: '明天下午三点',
    });
  });
});

describe('批3 跨服务写读路径（agent-execution）', () => {
  it('claim 写 user turn 加密 → prepareReplay 解密读回原文', async () => {
    const conv = await createConversation(TEACHER_A);
    const claimed = await agentExecutionService.claim({
      teacherId: TEACHER_A,
      conversationId: conv.id,
      clientRequestId: `req-enc3-${randomBytes(4).toString('hex')}`,
      message: '查一下今天的课程',
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // DB user turn 是密文
    const userTurn = await prisma.conversationTurn.findUniqueOrThrow({
      where: { id: claimed.value.execution.userTurnId as string },
    });
    expect(userTurn.content).not.toBe('查一下今天的课程');
    expect(cipher.decrypt(userTurn.content)).toBe('查一下今天的课程');

    // prepareReplay 读回解密（需要 failed 执行 + error turn）
    await agentExecutionService.fail({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      status: 'failed',
      stage: 'model',
      error: { code: 'INTERNAL_ERROR', message: '模型超时' },
      retryable: true,
      retryAction: 'retry-model',
      completedToolCallIds: [],
    });
    const replay = await agentExecutionService.prepareReplay({
      teacherId: TEACHER_A,
      executionId: claimed.value.execution.id,
      clientRequestId: `req-replay-${randomBytes(4).toString('hex')}`,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.message).toBe('查一下今天的课程');
  });
});

describe('批3 篡改拒绝 + 缺钥 SAFETY_BLOCK', () => {
  it('DB turn content 密文被篡改 → listTurns 返回 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const conv = await createConversation(TEACHER_A);
    const appended = await conversationService.appendTurn({
      conversationId: conv.id,
      teacherId: TEACHER_A,
      role: 'user',
      content: '篡改测试内容',
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const row = await prisma.conversationTurn.findUniqueOrThrow({ where: { id: appended.value.id } });
    const original = row.content;
    const parts = row.content.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.conversationTurn.update({ where: { id: appended.value.id }, data: { content: parts.join(':') } });

    try {
      const list = await conversationService.listTurns({ conversationId: conv.id, teacherId: TEACHER_A });
      expect(list.ok).toBe(false);
      if (list.ok) return;
      expect(list.error.code).toBe('INTERNAL_ERROR');
      expect(list.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.conversationTurn.update({ where: { id: appended.value.id }, data: { content: original } });
    }
  });

  it('ENCRYPTION_KEY 缺省 → appendTurn/saveNote 写路径 SAFETY_BLOCK', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const conv = await createConversation(TEACHER_A);
      const noKeyService = createConversationService({ prisma });
      const write = await noKeyService.appendTurn({
        conversationId: conv.id,
        teacherId: TEACHER_A,
        role: 'user',
        content: '不应落库',
      });
      expect(write.ok).toBe(false);
      if (write.ok) return;
      expect(write.error.message).toContain('SAFETY_BLOCK');

      const noKeyNotes = createAiNoteService({
        prisma,
        aiClient: { run: vi.fn(async () => ok({})) } as never,
        storage: createStorage({ rootDir: tempRoot }),
      });
      const noteWrite = await noKeyNotes.saveNote({
        teacherId: TEACHER_A,
        inputType: 'text',
        rawInput: '不应落库',
        status: 'processed',
      });
      expect(noteWrite.ok).toBe(false);
      if (noteWrite.ok) return;
      expect(noteWrite.error.message).toContain('SAFETY_BLOCK');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});
