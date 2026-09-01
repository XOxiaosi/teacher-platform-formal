import { Readable, Writable } from 'node:stream';
import type { Application, Request, Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createApp } from '../../src/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createAgentExecutionService } from '../../src/features/agent-execution/index.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createPresentationBuilder } from '../../src/app/presentation/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批3：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);
import { createToolRegistry } from '../../src/shared/tool-registry/index.js';

const prisma = new PrismaClient();
const TEACHER_ID = 'presentation-recovery-teacher';

interface ApiResponse {
  status: number;
  body: unknown;
}

type MockResponse = Writable & {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  removeHeader(key: string): void;
  end(chunk?: unknown): MockResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function requestApp(
  app: Application,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = new Readable({ read() { this.push(payload); this.push(null); } });
    Object.assign(req, {
      method,
      url,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload).toString(),
        ...headers,
      },
    });
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as MockResponse;
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.getHeader = (key) => res.headers[key.toLowerCase()];
    res.removeHeader = (key) => { delete res.headers[key.toLowerCase()]; };
    res.end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = text ? JSON.parse(text) : null;
      resolve({ status: res.statusCode, body: parsed });
      return res;
    };
    // Test-only adapter: these real Node streams gain Express fields above, but are not
    // full framework Request/Response instances at the static type boundary.
    app.handle(req as unknown as Request, res as unknown as Response, (error?: unknown) => {
      if (error) return reject(error);
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

async function cleanup() {
  await prisma.pendingAction.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.agentExecution.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.conversation.deleteMany({ where: { teacherId: TEACHER_ID } });
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('PresentationDocument persistence recovery workflow', () => {
  it('Agent构建V1信封写入Prisma，Conversation HTTP刷新恢复同一文档', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_ID } });
    const registry = createToolRegistry();
    registry.register({
      name: 'students.create',
      description: '创建学生展示夹具',
      parameters: {},
      sideEffect: 'create',
    }, async () => ok({
      id: 'student-1',
      teacherId: TEACHER_ID,
      name: '张三',
      grade: '高三',
      currentStatus: 'active',
    }));
    const chat = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: '正在创建',
          toolCalls: [{ id: 'call-student', name: 'students.create', args: {} }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { content: '已创建学生张三。' },
      });
    const agentConverse = createAgentConverseUseCase({
      conversationService: createConversationService({ prisma }),
      agentExecutions: createAgentExecutionService({ prisma }),
      aiClient: { run: vi.fn(), chat },
      toolRegistry: registry,
      presentationBuilder: createPresentationBuilder(),
    });
    const app = createApp(prisma, { agentConverse, rawPrisma: prisma });

    const converse = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '创建学生张三',
      clientRequestId: 'presentation-recovery-request-1',
    }, { 'x-teacher-id': TEACHER_ID });

    expect(converse).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: 'succeeded', reply: '已创建学生张三。' } },
    });
    const finalTurn = await prisma.conversationTurn.findFirstOrThrow({
      where: { conversationId: conversation.id, role: 'assistant', toolCalls: { equals: null } },
      orderBy: { createdAtTs: 'desc' },
    });
    // P8 phase-3 批3：toolResults 落库为密文，解密后断言
    expect(cipher.decryptJson<unknown>(finalTurn.toolResults as unknown as string)).toMatchObject({
      kind: 'assistant-presentation',
      version: 1,
      document: {
        schemaVersion: 1,
        summary: '已创建学生张三。',
        references: [{
          id: 'Student:student-1',
          type: 'Student',
          objectId: 'student-1',
          label: '张三',
        }],
      },
    });

    const turns = await requestApp(
      app,
      'GET',
      `/api/v1/conversations/${conversation.id}/turns`,
      undefined,
      { 'x-teacher-id': TEACHER_ID },
    );

    expect(turns.status).toBe(200);
    const items = property(property(turns.body, 'data'), 'items');
    expect(Array.isArray(items)).toBe(true);
    const assistant = Array.isArray(items)
      ? items.find((item) => (
        property(item, 'kind') === 'assistant'
        && property(item, 'content') === '已创建学生张三。'
      ))
      : undefined;
    const recoveredPresentation = property(assistant, 'presentation');
    const persistedPresentation = property(
      cipher.decryptJson<Record<string, unknown>>(finalTurn.toolResults as unknown as string),
      'document',
    );
    expect(recoveredPresentation).toEqual(persistedPresentation);
    expect(JSON.stringify(recoveredPresentation)).not.toContain(TEACHER_ID);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
