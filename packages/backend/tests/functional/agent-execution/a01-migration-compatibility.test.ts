import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

it('A01 additive migration preserves legacy messages, execution and confirmation values', async () => {
  const namespace = `a01_compat_${randomBytes(8).toString('hex')}`;
  const migration = readFileSync(resolve(__dirname, '../../../../contracts/prisma/migrations/20260922000000_add_a01_task_runtime/migration.sql'), 'utf8');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${namespace}"`);
    // Only tables touched by the additive migration; legacy payloads are opaque.
    await tx.$executeRawUnsafe('CREATE TABLE "Conversation" (id TEXT PRIMARY KEY, "teacherId" TEXT NOT NULL, summary TEXT)');
    await tx.$executeRawUnsafe('CREATE TABLE "ConversationTurn" (id TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, content TEXT NOT NULL)');
    await tx.$executeRawUnsafe('CREATE TABLE "AgentExecution" (id TEXT PRIMARY KEY, "teacherId" TEXT NOT NULL, "createdAtTs" TIMESTAMPTZ(3) NOT NULL, reply TEXT)');
    await tx.$executeRawUnsafe('CREATE TABLE "PendingAction" (id TEXT PRIMARY KEY, status TEXT NOT NULL, parameters JSONB NOT NULL)');
    await tx.$executeRawUnsafe(`INSERT INTO "Conversation" VALUES ('old-conversation', 'synthetic-teacher', 'old-summary')`);
    await tx.$executeRawUnsafe(`INSERT INTO "ConversationTurn" VALUES ('old-turn', 'old-conversation', 'opaque-existing-ciphertext')`);
    await tx.$executeRawUnsafe(`INSERT INTO "AgentExecution" VALUES ('old-execution', 'synthetic-teacher', '2026-01-01T00:00:00Z', 'old-reply')`);
    await tx.$executeRawUnsafe(`INSERT INTO "PendingAction" VALUES ('old-confirmation', 'pending', '{"synthetic":true}')`);
    for (const sql of migration.split(';').map((part) => part.trim()).filter(Boolean)) await tx.$executeRawUnsafe(sql);
    const conversations = await tx.$queryRawUnsafe('SELECT summary, "runtimeOwner", "nextEventSeq" FROM "Conversation"');
    expect(conversations).toEqual([{ summary: 'old-summary', runtimeOwner: null, nextEventSeq: 0 }]);
    const turns = await tx.$queryRawUnsafe('SELECT content, "taskId", seq, "redactedAtTs" FROM "ConversationTurn"');
    expect(turns).toEqual([{ content: 'opaque-existing-ciphertext', taskId: null, seq: null, redactedAtTs: null }]);
    const executions = await tx.$queryRawUnsafe('SELECT reply, "taskId" FROM "AgentExecution"');
    expect(executions).toEqual([{ reply: 'old-reply', taskId: null }]);
    const confirmations = await tx.$queryRawUnsafe('SELECT status, parameters FROM "PendingAction"');
    expect(confirmations).toEqual([{ status: 'pending', parameters: { synthetic: true } }]);
    await tx.$executeRawUnsafe(`DROP SCHEMA "${namespace}" CASCADE`);
  });
});
