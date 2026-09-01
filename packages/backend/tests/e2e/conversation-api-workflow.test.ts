import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Application } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/index.js';
import { createConversationService, type ConversationService } from '../../src/features/conversation/index.js';
import { createActionTokenSigner } from '../../src/features/pending-action/index.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../helpers/isolated-postgres.js';

let database: IsolatedPostgres;
let prisma: PrismaClient;
let conversations: ConversationService;
let app: Application;
const TEACHER_ID = 'test-teacher-conversation-api';

interface ApiResponse {
  status: number;
  body: any;
}

function requestApp(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = new Readable({
      read() {
        this.push(payload);
        this.push(null);
      },
    }) as any;
    req.method = method;
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload).toString(),
      ...headers,
    };

    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }) as any;
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (key: string, value: string) => { res.headers[key.toLowerCase()] = value; };
    res.getHeader = (key: string) => res.headers[key.toLowerCase()];
    res.removeHeader = (key: string) => { delete res.headers[key.toLowerCase()]; };
    res.end = (chunk?: unknown) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      return res;
    };

    app.handle(req, res, (error?: unknown) => {
      if (error) return reject(error);
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

function api(method: string, url: string, body?: unknown, teacherId = TEACHER_ID) {
  return requestApp(method, url, body, { 'x-teacher-id': teacherId });
}

async function cleanup() {
  const teacherIds = [TEACHER_ID];
  await prisma.pendingAction.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversationTurn.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.conversation.deleteMany({ where: { teacherId: { in: teacherIds } } });
}

async function createConversationOrThrow(teacherId = TEACHER_ID) {
  const result = await conversations.createConversation({ teacherId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function appendTurnOrThrow(input: {
  conversationId: string;
  teacherId?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown;
  toolResults?: unknown;
}) {
  const result = await conversations.appendTurn({
    conversationId: input.conversationId,
    teacherId: input.teacherId ?? TEACHER_ID,
    role: input.role,
    content: input.content,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
  conversations = createConversationService({ prisma });
  app = createApp(prisma, {
    rawPrisma: prisma,
    actionTokenSigner: createActionTokenSigner({
      secret: 'test-conversation-api-action-token-secret-32-bytes',
    }),
  });
}, 60_000);

beforeEach(cleanup);
afterEach(cleanup);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

describe('Conversation API 契约', () => {
  it('POST /conversations 从 header 创建会话，忽略 body teacherId', async () => {
    const response = await api('POST', '/api/v1/conversations', { teacherId: 'body-attacker-teacher' });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.conversation).toMatchObject({
      status: 'active',
      displayTitle: '新会话',
      summary: null,
      turnCount: 0,
    });
    const persisted = await prisma.conversation.findUniqueOrThrow({
      where: { id: response.body.data.conversation.id },
    });
    expect(persisted.teacherId).toBe(TEACHER_ID);
  });

  it('Conversation routes 缺少 teacher 身份时返回 401（P0 IDOR 修复：身份唯一来源 = requireAuth 注入）', async () => {
    const response = await requestApp('POST', '/api/v1/conversations', {});

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' },
    });
  });

  it('GET /conversations 返回当前 teacher 会话并投影 displayTitle', async () => {
    const own = await createConversationOrThrow();
    await appendTurnOrThrow({ conversationId: own.id, role: 'user', content: '帮我查看今天的课程安排' });

    const response = await api('GET', '/api/v1/conversations?status=active&limit=20');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        items: [expect.objectContaining({
          id: own.id,
          status: 'active',
          displayTitle: '帮我查看今天的课程安排',
          lastMessagePreview: '帮我查看今天的课程安排',
        })],
        nextCursor: null,
      },
    });
  });

  it('GET /conversations 拒绝非法 status 与 limit', async () => {
    const cases = [
      ['/api/v1/conversations?status=deleted', 'status'],
      ['/api/v1/conversations?limit=0', 'limit'],
      ['/api/v1/conversations?limit=abc', 'limit'],
    ] as const;

    for (const [url, field] of cases) {
      const response = await api('GET', url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR', field }),
      });
    }
  });

  it('GET /conversations 返回绑定排序信息的不透明 cursor', async () => {
    const first = await createConversationOrThrow();
    const second = await createConversationOrThrow();

    const response = await api('GET', '/api/v1/conversations?status=active&limit=1');

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.nextCursor).toBeTypeOf('string');
    expect(response.body.data.nextCursor).not.toBe(first.id);
    expect(response.body.data.nextCursor).not.toBe(second.id);
  });

  it('GET /conversations/:id 返回当前 teacher 会话详情', async () => {
    const conversation = await createConversationOrThrow();
    await appendTurnOrThrow({ conversationId: conversation.id, role: 'user', content: '查询学生' });

    const response = await api('GET', `/api/v1/conversations/${conversation.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.conversation).toMatchObject({
      id: conversation.id,
      displayTitle: '查询学生',
      turnCount: 1,
    });
  });

  it('GET /conversations/:id/turns 返回正序展示 DTO', async () => {
    const conversation = await createConversationOrThrow();
    const userTurn = await appendTurnOrThrow({ conversationId: conversation.id, role: 'user', content: '你好' });
    const assistantTurn = await appendTurnOrThrow({ conversationId: conversation.id, role: 'assistant', content: '你好，需要我处理什么？' });

    const response = await api('GET', `/api/v1/conversations/${conversation.id}/turns?limit=50`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        items: [
          expect.objectContaining({ id: userTurn.id, kind: 'user', content: '你好' }),
          expect.objectContaining({ id: assistantTurn.id, kind: 'assistant', content: '你好，需要我处理什么？' }),
        ],
        previousCursor: null,
      },
    });
  });

  it('turns 将持久化工具调用投影为完整 ToolTurnDto', async () => {
    const conversation = await createConversationOrThrow();
    await appendTurnOrThrow({
      conversationId: conversation.id,
      role: 'assistant',
      content: '正在查询',
      toolCalls: [{ id: 'call-1', name: 'students.get', args: { studentId: 'student-1', verbose: true } }],
    });
    const toolTurn = await appendTurnOrThrow({
      conversationId: conversation.id,
      role: 'tool',
      content: JSON.stringify({ id: 'student-1', name: '张三' }),
      toolResults: { toolCallId: 'call-1' },
    });

    const response = await api('GET', `/api/v1/conversations/${conversation.id}/turns`);

    expect(response.status).toBe(200);
    expect(response.body.data.items[1]).toEqual({
      id: toolTurn.id,
      conversationId: conversation.id,
      kind: 'tool',
      createdAt: toolTurn.createdAt.toISOString(),
      toolCallId: 'call-1',
      toolName: 'students.get',
      displayName: '查询学生详情',
      sideEffect: 'read',
      status: 'success',
      inputSummary: { studentId: 'student-1', verbose: true },
      resultSummary: '{"id":"student-1","name":"张三"}',
      references: [],
      error: null,
    });
  });

  it('turns 将关联 PendingAction 的 ToolTurn 替换为可刷新 ConfirmationTurnDto', async () => {
    const conversation = await createConversationOrThrow();
    await appendTurnOrThrow({
      conversationId: conversation.id,
      role: 'assistant',
      content: '等待确认',
      toolCalls: [{ id: 'call-confirm', name: 'students.updateStatus', args: { studentId: 'student-1', status: 'paused' } }],
    });
    await appendTurnOrThrow({
      conversationId: conversation.id,
      role: 'tool',
      content: '等待用户确认',
      toolResults: { toolCallId: 'call-confirm' },
    });
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
    const pending = await prisma.pendingAction.create({
      data: {
        teacherId: TEACHER_ID,
        conversationId: conversation.id,
        toolCallId: 'call-confirm',
        actionName: 'students.updateStatus',
        targetType: 'Student',
        targetId: 'student-1',
        parameters: { studentId: 'student-1', status: 'paused' },
        beforeSummary: 'active',
        afterSummary: 'paused',
        expiresAtTs: new Date(rows[0].now.getTime() + 600_000),
      },
    });

    const pendingResponse = await api('GET', `/api/v1/conversations/${conversation.id}/turns`);
    await prisma.pendingAction.update({
      where: { id: pending.id },
      data: { status: 'consumed', consumedAtTs: rows[0].now },
    });
    const consumedResponse = await api('GET', `/api/v1/conversations/${conversation.id}/turns`);

    expect(pendingResponse.status).toBe(200);
    expect(pendingResponse.body.data.items[1]).toMatchObject({
      id: pending.id,
      kind: 'confirmation',
      actionId: pending.id,
      status: 'pending',
      actionToken: expect.any(String),
      parameterSummary: { studentId: 'student-1', status: 'paused' },
    });
    expect(consumedResponse.body.data.items[1]).toMatchObject({
      id: pending.id,
      kind: 'confirmation',
      status: 'consumed',
      actionToken: null,
    });
  });

  it('POST /conversations/:id/archive 幂等，并使会话只读', async () => {
    const conversation = await createConversationOrThrow();

    const first = await api('POST', `/api/v1/conversations/${conversation.id}/archive`);
    const second = await api('POST', `/api/v1/conversations/${conversation.id}/archive`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data.conversation.status).toBe('archived');
    expect(second.body.data.conversation.status).toBe('archived');

    const converse = await api('POST', '/api/v1/agent/converse', {
      conversationId: conversation.id,
      message: '继续追加消息',
      clientRequestId: 'request-archived-conversation',
    });

    expect(converse.status).toBe(400);
    expect(converse.body).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    });
  });
});
