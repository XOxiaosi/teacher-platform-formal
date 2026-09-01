import { Readable, Writable } from 'node:stream';
import type { Application, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createConversationService } from '../../src/features/conversation/index.js';
import { createAgentExecutionService } from '../../src/features/agent-execution/index.js';
import { createAgentConverseUseCase } from '../../src/app/use-cases/agent-converse/index.js';
import { createExecutionRunners } from '../../src/app/reliability/execution-runners.js';
import { createToolRegistry } from '../../src/shared/tool-registry/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

// P8 phase-3 批3：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
const cipher = createFieldCipher(loadEncryptionKey().key);

interface ApiResponse { status: number; body: any }
type MockResponse = Writable & {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  removeHeader(key: string): void;
  end(chunk?: unknown): MockResponse;
};

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
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      return res;
    };
    app.handle(req as unknown as Request, res as unknown as Response, (error?: unknown) => {
      if (error) return reject(error);
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

const TEACHER_A = 'agent-reliability-teacher-a';
let database: IsolatedPostgres;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await createIsolatedPostgres('agent_reliability');
  prisma = database.prisma;
});
afterAll(async () => database.cleanup());
beforeEach(async () => {
  await prisma.conversationTurn.deleteMany();
  await prisma.agentExecution.deleteMany();
  await prisma.conversation.deleteMany();
});

function runtime(chat: ReturnType<typeof vi.fn>, timeoutMs = 100) {
  const conversations = createConversationService({ prisma });
  const agentExecutions = createAgentExecutionService({ prisma });
  return createAgentConverseUseCase({
    conversationService: conversations,
    agentExecutions,
    aiClient: { run: vi.fn(), chat },
    toolRegistry: createToolRegistry(),
    executionRunners: createExecutionRunners({ modelTimeoutMs: timeoutMs, readToolTimeoutMs: timeoutMs }),
  });
}

describe('Agent reliability HTTP workflow', () => {
  it('已有 running 返回 202，不启动第二次模型调用；指纹冲突返回 400', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const executions = createAgentExecutionService({ prisma });
    await executions.claim({
      teacherId: TEACHER_A,
      conversationId: conversation.id,
      message: '正在执行',
      clientRequestId: 'request-running-0001',
    });
    const chat = vi.fn().mockResolvedValue({ ok: true, value: { content: '不应调用' } });
    const app = createApp(prisma, { agentConverse: runtime(chat) });

    const replay = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '正在执行',
      clientRequestId: 'request-running-0001',
    }, { 'x-teacher-id': TEACHER_A });
    const conflict = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '篡改消息',
      clientRequestId: 'request-running-0001',
    }, { 'x-teacher-id': TEACHER_A });

    expect(replay).toMatchObject({ status: 202, body: { ok: true, data: { status: 'running', replayed: true } } });
    expect(conflict).toMatchObject({
      status: 400,
      body: { ok: false, error: { code: 'VALIDATION_ERROR', field: 'clientRequestId' } },
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it('相同 clientRequestId 重放持久化结果，不重复模型与 user turn', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const chat = vi.fn().mockResolvedValue({ ok: true, value: { content: '已完成' } });
    const app = createApp(prisma, { agentConverse: runtime(chat) });
    const body = {
      conversationId: conversation.id,
      message: '查一下今天的课程',
      clientRequestId: 'request-idempotent-001',
    };

    const first = await requestApp(app, 'POST', '/api/v1/agent/converse', body, { 'x-teacher-id': TEACHER_A });
    const second = await requestApp(app, 'POST', '/api/v1/agent/converse', body, { 'x-teacher-id': TEACHER_A });

    expect(first).toMatchObject({ status: 200, body: { ok: true, data: { status: 'succeeded', replayed: false } } });
    expect(second).toMatchObject({ status: 200, body: { ok: true, data: { status: 'succeeded', replayed: true } } });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(await prisma.conversationTurn.count({ where: { role: 'user' } })).toBe(1);
    expect(await prisma.agentExecution.count()).toBe(1);
  });

  it('写工具完成后后续工具失败收口 partial，禁止安全回放', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const registry = createToolRegistry();
    registry.register({
      name: 'test.create', description: 'create', parameters: { type: 'object' }, sideEffect: 'create',
    }, async () => ({ ok: true, value: { id: 'created-1' } }));
    registry.register({
      name: 'test.read-fail', description: 'read', parameters: { type: 'object' }, sideEffect: 'read',
    }, async () => ({ ok: false, error: { code: 'INTERNAL_ERROR', message: '读取失败' } }));
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        content: '',
        toolCalls: [
          { id: 'call-create', name: 'test.create', args: {} },
          { id: 'call-read', name: 'test.read-fail', args: {} },
        ],
      },
    });
    const agentConverse = createAgentConverseUseCase({
      conversationService: createConversationService({ prisma }),
      agentExecutions: createAgentExecutionService({ prisma }),
      aiClient: { run: vi.fn(), chat },
      toolRegistry: registry,
      executionRunners: createExecutionRunners({ modelTimeoutMs: 100, readToolTimeoutMs: 100 }),
    });
    const app = createApp(prisma, { agentConverse });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '先写后读',
      clientRequestId: 'request-partial-0001',
    }, { 'x-teacher-id': TEACHER_A });

    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { status: 'partial' } } });
    const replay = await requestApp(
      app,
      'POST',
      `/api/v1/agent/executions/${response.body.data.executionId}/replay`,
      { clientRequestId: 'request-partial-replay-01' },
      { 'x-teacher-id': TEACHER_A },
    );
    expect(replay).toMatchObject({
      status: 400,
      body: { ok: false, error: { code: 'VALIDATION_ERROR', field: 'executionId' } },
    });
  });

  it('未知工具按写风险 fail-closed，不获得只读重试资格', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        content: '',
        toolCalls: [{ id: 'call-unknown', name: 'unknown.tool', args: {} }],
      },
    });
    const app = createApp(prisma, { agentConverse: runtime(chat) });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '调用不存在的工具',
      clientRequestId: 'request-unknown-tool-001',
    }, { 'x-teacher-id': TEACHER_A });

    expect(response).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: 'failed' } },
    });
    const turns = await requestApp(app, 'GET', `/api/v1/conversations/${conversation.id}/turns`, undefined, {
      'x-teacher-id': TEACHER_A,
    });
    expect(turns.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error',
        stage: 'tool',
        retryable: false,
        retryAction: 'none',
        error: { code: 'NOT_FOUND', message: '工具 unknown.tool 未注册' },
      }),
    ]));
  });

  it('达到最大工具轮次后持久化友好 error turn，不继续执行', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const chat = vi.fn().mockResolvedValue({
      ok: true,
      value: { content: '', toolCalls: [{ id: 'call-loop', name: 'test.read', args: {} }] },
    });
    const registry = createToolRegistry();
    const execute = vi.fn().mockResolvedValue({ ok: true, value: { found: true } });
    registry.register({
      name: 'test.read', description: 'test', parameters: { type: 'object' }, sideEffect: 'read',
    }, execute);
    const conversations = createConversationService({ prisma });
    const agentConverse = createAgentConverseUseCase({
      conversationService: conversations,
      agentExecutions: createAgentExecutionService({ prisma }),
      aiClient: { run: vi.fn(), chat },
      toolRegistry: registry,
      executionRunners: createExecutionRunners({ modelTimeoutMs: 100, readToolTimeoutMs: 100 }),
    });
    const app = createApp(prisma, { agentConverse });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '循环调用',
      clientRequestId: 'request-max-rounds-001',
    }, { 'x-teacher-id': TEACHER_A });

    expect(response).toMatchObject({ status: 200, body: { ok: true, data: { status: 'failed' } } });
    expect(chat).toHaveBeenCalledTimes(6);
    expect(execute).toHaveBeenCalledTimes(5);
    // P8 phase-3 批3：content 已加密，不能按明文 contains 查询——取 error turn 解密后断言
    const errorTurns = await prisma.conversationTurn.findMany({
      where: { role: 'error' },
    });
    expect(errorTurns.some((turn) => cipher.decrypt(turn.content).includes('工具调用上限'))).toBe(true);
  });

  it('模型 timeout 持久化 failed execution 与可刷新 error turn', async () => {
    const conversation = await prisma.conversation.create({ data: { teacherId: TEACHER_A } });
    const chat = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, value: { content: '重试完成' } });
    const app = createApp(prisma, { agentConverse: runtime(chat, 5) });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '生成总结',
      clientRequestId: 'request-timeout-0001',
    }, { 'x-teacher-id': TEACHER_A });

    expect(response).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: 'failed', reply: null, replayed: false } },
    });
    const turns = await requestApp(app, 'GET', `/api/v1/conversations/${conversation.id}/turns`, undefined, {
      'x-teacher-id': TEACHER_A,
    });
    expect(turns.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'error', stage: 'model', retryable: true,
        retryAction: 'retry-model', error: { code: 'INTERNAL_ERROR', message: '模型响应超时' },
      }),
    ]));

    const replay = await requestApp(
      app,
      'POST',
      `/api/v1/agent/executions/${response.body.data.executionId}/replay`,
      { clientRequestId: 'request-timeout-replay-0001' },
      { 'x-teacher-id': TEACHER_A },
    );
    expect(replay).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: 'succeeded', reply: '重试完成', replayed: false } },
    });
    expect(await prisma.agentExecution.count()).toBe(2);
  });
});
