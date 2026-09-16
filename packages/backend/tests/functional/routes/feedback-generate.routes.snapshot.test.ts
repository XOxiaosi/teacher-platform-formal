import { ok, err, notFound } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDependencies, invokePostFeedback, invokeGetFeedback, invokeGetSnapshot } from './feedback-generate.routes.fixtures.js';

describe('POST /feedback', () => {
  it('成功：带 evidence 创建反馈返回 201', async () => {
    const deps = createDependencies();
    const mockFeedback = { id: 'fb-1', title: '测试', content: '内容' };
    (deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback.mockResolvedValue(ok(mockFeedback));

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: {
        studentId: 'student-1',
        title: '测试',
        content: '内容',
        evidence: [{ id: 'formal-record-1', type: 'record', occurredAt: '2026-01-01T00:00:00Z', sourceVersion: 'a'.repeat(64) }],
        windowStart: '2026-01-01T00:00:00Z',
        windowEnd: '2026-02-01T00:00:00Z',
      },
    });

    expect(statusCode).toBe(201);
    expect(responseBody).toEqual({ ok: true, data: mockFeedback });
    expect((deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        studentId: 'student-1',
        title: '测试',
        content: '内容',
        evidence: [{ id: 'formal-record-1', type: 'record', occurredAt: '2026-01-01T00:00:00Z', sourceVersion: 'a'.repeat(64) }],
        windowStart: '2026-01-01T00:00:00Z',
        windowEnd: '2026-02-01T00:00:00Z',
      }),
    );
  });

  it('缺 title 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', content: '内容' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'title' } });
  });

  it('evidence 非数组返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', title: '标题', content: '内容', evidence: 'not-array' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'evidence' } });
    expect((deps.feedbackService as { createFeedback: ReturnType<typeof vi.fn> }).createFeedback).not.toHaveBeenCalled();
  });

  it('缺少 teacherId 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokePostFeedback({
      dependencies: deps,
      body: { studentId: 'student-1', title: '标题', content: '内容' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('GET /feedback', () => {
  it('成功：列表返回 200', async () => {
    const deps = createDependencies();
    const mockResult = { items: [{ id: 'fb-1' }], total: 1 };
    (deps.feedbackService as { listFeedbacks: ReturnType<typeof vi.fn> }).listFeedbacks.mockResolvedValue(ok(mockResult));

    const { statusCode, responseBody } = await invokeGetFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      query: { studentId: 'student-1', status: 'draft', page: '1', pageSize: '10' },
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({ ok: true, data: mockResult });
    expect((deps.feedbackService as { listFeedbacks: ReturnType<typeof vi.fn> }).listFeedbacks).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        studentId: 'student-1',
        status: 'draft',
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it('非法 status 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokeGetFeedback({
      dependencies: deps,
      teacherId: 'teacher-1',
      query: { status: 'invalid' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'status' } });
  });
});

describe('GET /feedback/:feedbackId/snapshot', () => {
  it('成功：快照返回 200', async () => {
    const deps = createDependencies();
    const mockSnapshot = {
      feedbackId: 'fb-1',
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:00:00.000Z',
      assembledAt: '2026-03-01T00:00:00.000Z',
      evidence: [],
    };
    (deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot.mockResolvedValue(ok(mockSnapshot));

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      teacherId: 'teacher-1',
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({ ok: true, data: mockSnapshot });
    expect((deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      feedbackId: 'fb-1',
    });
  });

  it('NOT_FOUND 跨 teacher 透传 404', async () => {
    const deps = createDependencies();
    (deps.feedbackService as { getFeedbackSnapshot: ReturnType<typeof vi.fn> }).getFeedbackSnapshot.mockResolvedValue(
      err(notFound('该反馈没有依据快照')),
    );

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      teacherId: 'teacher-2',
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('缺少 teacherId 返回 400', async () => {
    const deps = createDependencies();

    const { statusCode, responseBody } = await invokeGetSnapshot({
      dependencies: deps,
      feedbackId: 'fb-1',
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  });
});
