import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgentExecutionService } from '../../../src/features/agent-execution/index.js';
import { createConversationService } from '../../../src/features/conversation/index.js';

const prisma = new PrismaClient();
const teacherId = `a01-ownership-${randomUUID()}`;
const executions = createAgentExecutionService({ prisma });
const conversations = createConversationService({ prisma });

afterAll(async () => {
  await prisma.stepReceipt.deleteMany({ where: { teacherId } });
  await prisma.agentExecution.deleteMany({ where: { teacherId } });
  await prisma.taskRuntime.deleteMany({ where: { teacherId } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId } });
  await prisma.conversation.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('A01 separates legacy and teaching-task execution', () => {
  it('legacy claim cannot receive or append to a new runtime conversation', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId, runtimeOwner: 'dsh-v1' } });
    const input = { teacherId, conversationId: conversation.id };
    expect((await executions.claim({ ...input, message: 'synthetic task', clientRequestId: randomUUID() })).ok).toBe(false);
    expect((await conversations.appendTurn({ ...input, role: 'assistant', content: 'legacy response' })).ok).toBe(false);
    expect((await conversations.buildContext(input)).ok).toBe(false);
    expect((await conversations.updateSummary({ ...input, summary: 'legacy summary' })).ok).toBe(false);
    expect(await prisma.conversationTurn.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect(await prisma.agentExecution.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it('legacy completion, failure and replay cannot take over a task execution', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId, runtimeOwner: 'dsh-v1' } });
    const task = await prisma.taskRuntime.create({ data: { teacherId, conversationId: conversation.id } });
    const execution = await prisma.agentExecution.create({ data: {
      teacherId, conversationId: conversation.id, taskId: task.id,
      clientRequestId: randomUUID(), requestFingerprint: 'synthetic',
    } });
    expect((await executions.get({ teacherId, executionId: execution.id })).ok).toBe(false);
    expect((await executions.complete({ teacherId, executionId: execution.id, status: 'succeeded', stage: 'model', reply: 'legacy response', completedToolCallIds: [] })).ok).toBe(false);
    expect((await executions.fail({ teacherId, executionId: execution.id, status: 'failed', stage: 'model', error: { code: 'INTERNAL_ERROR', message: 'synthetic' }, retryable: true, retryAction: 'retry-model', completedToolCallIds: [] })).ok).toBe(false);
    expect((await executions.prepareReplay({ teacherId, executionId: execution.id, clientRequestId: randomUUID() })).ok).toBe(false);
    expect((await prisma.agentExecution.findUniqueOrThrow({ where: { id: execution.id } })).status).toBe('running');
    expect(await prisma.conversationTurn.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it('preserves the existing legacy claim and duplicate receipt behavior', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId } });
    const input = { teacherId, conversationId: conversation.id, clientRequestId: randomUUID(), message: 'synthetic legacy message' };
    const first = await executions.claim(input);
    const replay = await executions.claim(input);
    expect(first.ok && replay.ok && first.value.execution.id === replay.value.execution.id).toBe(true);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).runtimeOwner).toBe('legacy');
    expect(await prisma.conversationTurn.count({ where: { conversationId: conversation.id } })).toBe(1);
  });
});
