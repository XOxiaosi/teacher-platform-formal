import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';

// Phase 1.11-A: 红灯测试
// Agent API route 不存在，createApp/createCoreRouter 不支持 agentConverse DI。
// 测试锁定 Phase 1.11 预期契约，实现将在 Phase 1.11-B 完成。
//
// 最小 DI 契约：
//   createApp(prisma, { agentConverse: fakeUseCase })
//   或 createCoreRouter(prisma, { agentConverse: fakeUseCase })
//
// 最小 API 契约：
//   POST /api/v1/agent/converse
//   Headers: x-teacher-id: string
//   Body: { conversationId: string, message: string }
//   Response: { ok: true, data: { conversationId, reply } } | { ok: false, error }

// ---- Fake agent-converse use-case ----

interface FakeAgentConverse {
  execute: ReturnType<typeof vi.fn>;
}

function createFakeAgentConverse(): FakeAgentConverse {
  return {
    execute: vi.fn().mockResolvedValue({
      ok: true,
      value: { conversationId: 'conv-1', reply: '你好，我是 AI 助手' },
    }),
  };
}

// ---- 尝试创建带 DI 的 app ----
// 当前 createApp 不支持 options 参数，这会导致 import 或调用失败
let createApp: any;
try {
  const mod = await import('../../src/index.js');
  createApp = mod.createApp;
} catch {
  // 模块不存在
}

// ---- 请求 helper ----

interface ApiResponse {
  status: number;
  body: any;
}

function requestApp(app: any, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
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
      if (error) {
        reject(error);
        return;
      }
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

// ---- 测试 ----

describe('Agent API route 契约（Phase 1.11-A 红灯）', () => {
  it('createApp 支持注入 agentConverse use-case', () => {
    // 这是 DI 契约的基本保证：createApp 应支持 options 参数
    expect(createApp).toBeDefined();

    // 当前 createApp 签名是 createApp(prisma?)，不支持 options
    // Phase 1.11-B 应扩展为 createApp(prisma, { agentConverse })
    // 此测试会在 Phase 1.11-B 实现后通过
    const fakeUseCase = createFakeAgentConverse();

    // 尝试创建带 DI 的 app（当前会失败，因为 createApp 不支持 options）
    expect(() => {
      const app = createApp(undefined, { agentConverse: fakeUseCase });
      expect(app).toBeDefined();
    }).not.toThrow();
  });

  it('缺 x-teacher-id 返回 401（P0 IDOR 修复：身份唯一来源 = requireAuth 注入）', async () => {
    if (!createApp) return;

    const fakeUseCase = createFakeAgentConverse();
    const app = createApp(undefined, { agentConverse: fakeUseCase });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: 'conv-1',
      message: '你好',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: '未登录或会话已过期' },
    });
    // use-case 不应被调用
    expect(fakeUseCase.execute).not.toHaveBeenCalled();
  });

  it('缺 conversationId 返回 400 VALIDATION_ERROR', async () => {
    if (!createApp) return;

    const fakeUseCase = createFakeAgentConverse();
    const app = createApp(undefined, { agentConverse: fakeUseCase });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      message: '缺少 conversationId',
    }, { 'x-teacher-id': 'test-teacher' });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(fakeUseCase.execute).not.toHaveBeenCalled();
  });

  it('缺 message 返回 400 VALIDATION_ERROR', async () => {
    if (!createApp) return;

    const fakeUseCase = createFakeAgentConverse();
    const app = createApp(undefined, { agentConverse: fakeUseCase });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: 'conv-1',
    }, { 'x-teacher-id': 'test-teacher' });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(fakeUseCase.execute).not.toHaveBeenCalled();
  });

  it('带 fake agentConverse 成功时：route 调用 execute 并返回 { ok: true, data }', async () => {
    if (!createApp) return;

    const fakeUseCase = createFakeAgentConverse();
    fakeUseCase.execute.mockResolvedValue({
      ok: true,
      value: { conversationId: 'conv-123', reply: '已创建学生张三' },
    });

    const app = createApp(undefined, { agentConverse: fakeUseCase });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: 'conv-123',
      message: '帮我创建学生张三',
      clientRequestId: 'request-success-001',
    }, { 'x-teacher-id': 'teacher-abc' });

    // 应返回成功响应
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({
      conversationId: 'conv-123',
      reply: '已创建学生张三',
    });

    // 应调用 use-case，参数包含 teacherId, conversationId, message
    expect(fakeUseCase.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-abc',
      conversationId: 'conv-123',
      message: '帮我创建学生张三',
      clientRequestId: 'request-success-001',
    });
  });

  it('fake agentConverse 返回 err 时：route 映射为 { ok: false, error }', async () => {
    if (!createApp) return;

    const fakeUseCase = createFakeAgentConverse();
    fakeUseCase.execute.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: '会话不存在' },
    });

    const app = createApp(undefined, { agentConverse: fakeUseCase });

    const response = await requestApp(app, 'POST', '/api/v1/agent/converse', {
      conversationId: 'nonexistent',
      message: '测试错误',
      clientRequestId: 'request-error-001',
    }, { 'x-teacher-id': 'test-teacher' });

    // 应返回错误响应
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toEqual({
      code: 'NOT_FOUND',
      message: '会话不存在',
    });
  });
});
