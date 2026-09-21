import { ok, err, notFound } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDependencies, invokeRoute, routeEvidence } from './feedback-generate.routes.fixtures.js';

describe('POST /feedback/generate-draft', () => {
  it('成功：带认证 teacherId + {studentId, tone} 返回 201 与完整 data 形状', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: ['lesson-1', 'lesson-2'],
      title: '本周学习反馈',
      content: '本周课堂表现良好。',
      rationale: '用课堂表现给家长确定感。',
      source: 'ai',
      evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', tone: 'warm' },
    });

    expect(statusCode).toBe(201);
    expect(responseBody).toEqual({ ok: true, data: draft });
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'student-1',
      lessonIds: undefined,
      recordIds: undefined,
      tone: 'warm',
      classSize: undefined,
      parentType: undefined,
      focus: undefined,
    });
  });

  it('缺少 x-teacher-id 返回 400 且不派发用例', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      body: { studentId: 'student-1' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('缺少 studentId 返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { tone: 'warm' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('studentId 非字符串返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 123 },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('lessonIds 含非字符串返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', lessonIds: ['lesson-1', 42] },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('recordIds 只携带已核对的指定记录，并与 lessonIds 互斥', async () => {
    const dependencies = createDependencies();
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok({
      studentId: 'student-1', lessonIds: [], title: 'x', content: 'y', rationale: 'z', source: 'ai', evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-31T00:00:00.000Z',
    }));
    const success = await invokeRoute({ dependencies, teacherId: 'teacher-1', body: { studentId: 'student-1', recordIds: ['record-1'] } });
    expect(success.statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['record-1'] }));

    const invalid = await invokeRoute({ dependencies, teacherId: 'teacher-1', body: { studentId: 'student-1', recordIds: ['record-1'], lessonIds: ['lesson-1'] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'recordIds' } });
  });

  it('tone 非白名单返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', tone: 'angry' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('use-case 返回 notFound（学生不存在）时透传 404', async () => {
    const dependencies = createDependencies();
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => err(notFound('学生不存在')));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'missing-student' },
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'missing-student',
      lessonIds: undefined,
      recordIds: undefined,
      tone: undefined,
      classSize: undefined,
      parentType: undefined,
      focus: undefined,
    });
  });

  // ===== 新增：可选字段校验与透传 =====

  it('classSize 合法值（1v1/small/large）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      classSize: '1v1' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', classSize: '1v1' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ classSize: '1v1' }),
    );
  });

  it('classSize 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', classSize: 'huge' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'classSize' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('parentType 合法值（normal/scores/sensitive）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      parentType: 'scores' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', parentType: 'scores' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ parentType: 'scores' }),
    );
  });

  it('parentType 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', parentType: 'crazy' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'parentType' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('focus 合法值（highlight/problem/cooperation/summary）通过并透传给 use case', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
      focus: 'highlight' as const,
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', focus: 'highlight' },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith(
      expect.objectContaining({ focus: 'highlight' }),
    );
  });

  it('focus 非法值返回 VALIDATION_ERROR', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: { studentId: 'student-1', focus: 'praise' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', field: 'focus' },
    });
    expect(dependencies.generateFeedbackDraft.execute).not.toHaveBeenCalled();
  });

  it('三个可选字段一起合法透传：classSize + parentType + focus', async () => {
    const dependencies = createDependencies();
    const draft = {
      studentId: 'student-1',
      lessonIds: [],
      title: 'x',
      content: 'y',
      rationale: 'z',
      source: 'ai' as const,
      evidence: routeEvidence,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T00:00:00.000Z',
    };
    dependencies.generateFeedbackDraft.execute = vi.fn(async () => ok(draft));

    const { statusCode } = await invokeRoute({
      dependencies,
      teacherId: 'teacher-1',
      body: {
        studentId: 'student-1',
        classSize: 'small',
        parentType: 'sensitive',
        focus: 'cooperation',
      },
    });

    expect(statusCode).toBe(201);
    expect(dependencies.generateFeedbackDraft.execute).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: 'student-1',
      lessonIds: undefined,
      tone: undefined,
      classSize: 'small',
      parentType: 'sensitive',
      focus: 'cooperation',
    });
  });
});
