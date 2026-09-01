import { Readable, Writable } from 'node:stream';
import express from 'express';
import type { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { SaveRawInputUseCase } from '../../src/app/use-cases/save-raw-input/types.js';
import { createAiInputRouter } from '../../src/app/routes/ai-input.routes.js';

interface ApiResponse {
  status: number;
  body: {
    ok?: boolean;
    error?: unknown;
    data?: { noteId?: string };
  } | null;
}

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
    const req = new Readable({
      read() {
        this.push(payload);
        this.push(null);
      },
    });
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
      resolve({ status: res.statusCode, body: text ? JSON.parse(text) as ApiResponse['body'] : null });
      return res;
    };

    app.handle(req as unknown as Request, res as unknown as Response, (error?: unknown) => {
      if (error) return reject(error);
      resolve({ status: res.statusCode === 200 ? 404 : res.statusCode, body: null });
    });
  });
}

function createFakeSaveRawInput(): SaveRawInputUseCase {
  return {
    saveRawInput: vi.fn(async (input) => ({
      ok: true,
      value: {
        noteId: 'note-1',
        rawInput: input.text ?? '',
        audioFileRef: null,
        savedNote: {
          id: 'note-1',
          teacherId: input.teacherId,
          inputType: input.inputType,
          rawInput: input.text ?? '',
          audioFileRef: null,
          intent: null,
          extractedData: {},
          confidence: null,
          pendingFields: [],
          status: 'processed',
          routedTo: null,
          routedModuleId: null,
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
        },
      },
    })),
  };
}

function createTestApp(saveRawInput: SaveRawInputUseCase): Application {
  const app = express();
  app.use(express.json());
  // P0 IDOR 修复：路由层身份只来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）。
  // 本测试直挂路由工厂（不经 requireAuth），用轻量中间件模拟认证层 dev fallback 的注入语义。
  app.use((req, _res, next) => {
    const header = req.header('x-teacher-id');
    if (header) (req as Request & { teacherId?: string }).teacherId = header;
    next();
  });
  app.use(createAiInputRouter({ saveRawInput }));
  return app;
}

describe('AI input route契约', () => {
  it('缺少teacherId时返回400且不调用use-case', async () => {
    const saveRawInput = createFakeSaveRawInput();

    const response = await requestApp(
      createTestApp(saveRawInput),
      'POST',
      '/ai/raw-input',
      { text: '课堂记录' },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '缺少 teacherId', field: 'teacherId' },
    });
    expect(saveRawInput.saveRawInput).not.toHaveBeenCalled();
  });

  it('默认text输入并以201返回保存结果', async () => {
    const saveRawInput = createFakeSaveRawInput();

    const response = await requestApp(
      createTestApp(saveRawInput),
      'POST',
      '/ai/raw-input',
      { text: '课堂记录' },
      { 'x-teacher-id': 'teacher-1' },
    );

    expect(saveRawInput.saveRawInput).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      inputType: 'text',
      text: '课堂记录',
    });
    expect(response.status).toBe(201);
    expect(response.body?.ok).toBe(true);
    expect(response.body?.data?.noteId).toBe('note-1');
  });
});
