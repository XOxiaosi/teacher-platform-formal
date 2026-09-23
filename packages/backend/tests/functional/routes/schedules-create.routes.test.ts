import type { Request, Response } from 'express';
import { ok } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleRouteDependencies } from '../../../src/app/composition/types.js';
import { createScheduleRouter } from '../../../src/app/routes/schedules.routes.js';
import { COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE } from '../../../src/app/policies/completion-entrypoint-gate.js';
import type { ScheduleData } from '../../../src/features/scheduling/types.js';

const CREATED_AT = new Date('2030-07-01T00:00:00.000Z');

function schedule(overrides: Partial<ScheduleData> = {}): ScheduleData {
  return {
    id: 'schedule-1',
    teacherId: 'teacher-a',
    studentId: 'student-1',
    participantIds: ['student-1'],
    type: 'lesson',
    title: '旧标题仍是领域数据',
    location: '工作室 A',
    classFormat: 'one_to_one',
    operationalNote: '先确认错题订正',
    scheduledStart: new Date('2030-08-20T01:00:00.000Z'),
    scheduledEnd: new Date('2030-08-20T02:30:00.000Z'),
    status: 'planned',
    confidence: 'high',
    pendingFields: ['none'],
    sourceInput: '教师手工排期',
    parentId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function dependencies() {
  return {
    schedules: {
      listSchedules: vi.fn(),
      cancelSchedule: vi.fn(),
      restoreSchedule: vi.fn(),
    },
    plannedSchedules: { create: vi.fn() },
    scheduleComplete: { completeSchedule: vi.fn() },
  } as unknown as ScheduleRouteDependencies;
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

async function invoke(options: {
  dependencies: ScheduleRouteDependencies;
  method: 'get' | 'post';
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  teacherId?: string;
}) {
  const router = createScheduleRouter(options.dependencies);
  const route = (router.stack as RouteLayer[]).find((layer) => (
    layer.route?.path === options.path && layer.route.methods[options.method]
  ))?.route;
  if (!route) throw new Error(`route not registered: ${options.method.toUpperCase()} ${options.path}`);

  let status = 200;
  let result: unknown;
  const request = {
    body: options.body,
    query: options.query ?? {},
    params: options.params ?? {},
    teacherId: options.teacherId,
  } as unknown as Request;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { result = value; return this; },
  } as Response;

  await route.stack[0]!.handle(request, response);
  return { status, result };
}

describe('createScheduleRouter 的创建与领域响应契约', () => {
  it('正式课程精确透传结构化字段，并以完整领域结果返回 201', async () => {
    const deps = dependencies();
    const created = schedule();
    const conflict = schedule({
      id: 'schedule-conflict',
      title: '另一条完整领域日程',
      status: 'planned',
    });
    const create = deps.plannedSchedules.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue(ok({ schedule: created, conflicts: [conflict] }));
    const payload = {
      clientRequestId: 'schedule-create-001',
      participantIds: ['student-1'],
      type: 'lesson',
      location: '工作室 A',
      classFormat: 'one_to_one',
      operationalNote: '先确认错题订正',
      scheduledStart: '2030-08-20T09:00:00+08:00',
      scheduledEnd: '2030-08-20T10:30:00+08:00',
      confidence: 'high',
      pendingFields: ['none'],
      sourceInput: '教师手工排期',
    };

    const response = await invoke({
      dependencies: deps,
      method: 'post',
      path: '/schedules',
      body: payload,
      teacherId: 'teacher-a',
    });

    expect(create).toHaveBeenCalledExactlyOnceWith({
      teacherId: 'teacher-a',
      clientRequestId: payload.clientRequestId,
      studentId: undefined,
      participantIds: payload.participantIds,
      type: payload.type,
      title: undefined,
      location: payload.location,
      classFormat: payload.classFormat,
      operationalNote: payload.operationalNote,
      scheduledStart: payload.scheduledStart,
      scheduledEnd: payload.scheduledEnd,
      confidence: payload.confidence,
      pendingFields: payload.pendingFields,
      sourceInput: payload.sourceInput,
    });
    expect(response).toEqual({
      status: 201,
      result: { ok: true, data: { schedule: created, conflicts: [conflict] } },
    });
  });

  it('正式课程携带 title 时在路由层拒绝，且不调用领域写入', async () => {
    const deps = dependencies();
    const create = deps.plannedSchedules.create as ReturnType<typeof vi.fn>;

    const response = await invoke({
      dependencies: deps,
      method: 'post',
      path: '/schedules',
      teacherId: 'teacher-a',
      body: {
        type: 'lesson',
        title: '不应进入正式课程',
        participantIds: ['student-1'],
        location: '工作室 A',
        classFormat: 'one_to_one',
        scheduledStart: '2030-08-20T09:00:00+08:00',
        scheduledEnd: '2030-08-20T10:30:00+08:00',
      },
    });

    expect(response).toEqual({
      status: 400,
      result: {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: '课程排期不接受课程名称', field: 'title' },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('未认证请求不会调用创建用例', async () => {
    const deps = dependencies();
    const create = deps.plannedSchedules.create as ReturnType<typeof vi.fn>;

    const response = await invoke({
      dependencies: deps,
      method: 'post',
      path: '/schedules',
      body: {
        type: 'lesson', participantIds: ['student-1'], location: '工作室 A', classFormat: 'one_to_one',
        scheduledStart: '2030-08-20T09:00:00+08:00', scheduledEnd: '2030-08-20T10:30:00+08:00',
      },
    });

    expect(response).toEqual({
      status: 400,
      result: { ok: false, error: { code: 'VALIDATION_ERROR', message: '缺少 teacherId', field: 'teacherId' } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('GET 保留会议的完整领域字段，不能因课程展示规则裁剪', async () => {
    const deps = dependencies();
    const meeting = schedule({
      id: 'meeting-1',
      type: 'meeting',
      title: '教研会议标题',
      studentId: null,
      participantIds: [],
      location: null,
      classFormat: null,
      operationalNote: null,
      confidence: null,
      pendingFields: null,
      sourceInput: '日历导入',
      parentId: 'parent-1',
    });
    const list = deps.schedules.listSchedules as ReturnType<typeof vi.fn>;
    list.mockResolvedValue(ok({ items: [meeting], total: 1 }));

    const response = await invoke({
      dependencies: deps,
      method: 'get',
      path: '/schedules',
      teacherId: 'teacher-a',
    });

    expect(list).toHaveBeenCalledExactlyOnceWith({
      teacherId: 'teacher-a', studentId: undefined, type: undefined, status: undefined,
      dateFrom: undefined, dateTo: undefined, page: undefined, pageSize: undefined,
    });
    expect(response).toEqual({ status: 200, result: { ok: true, data: { items: [meeting], total: 1 } } });
  });

  it('旧完课入口统一拒绝且不调用写入用例；取消与恢复不受影响', async () => {
    const deps = dependencies();
    const completed = schedule({ status: 'completed' });
    const cancelled = schedule({ status: 'cancelled' });
    const restored = schedule({ status: 'planned' });
    (deps.schedules.cancelSchedule as ReturnType<typeof vi.fn>).mockResolvedValue(ok(cancelled));
    (deps.schedules.restoreSchedule as ReturnType<typeof vi.fn>).mockResolvedValue(ok(restored));

    const complete = await invoke({
      dependencies: deps, method: 'post', path: '/schedules/:scheduleId/complete',
      params: { scheduleId: completed.id }, teacherId: 'teacher-a', body: { lessonStatus: 'absent' },
    });
    const cancel = await invoke({
      dependencies: deps, method: 'post', path: '/schedules/:scheduleId/cancel',
      params: { scheduleId: cancelled.id }, teacherId: 'teacher-a', body: {},
    });
    const restore = await invoke({
      dependencies: deps, method: 'post', path: '/schedules/:scheduleId/restore',
      params: { scheduleId: restored.id }, teacherId: 'teacher-a', body: {},
    });

    expect(complete).toEqual({ status: 400, result: {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, field: 'completion' },
    } });
    expect(deps.scheduleComplete.completeSchedule).not.toHaveBeenCalled();
    expect(cancel).toEqual({ status: 200, result: { ok: true, data: cancelled } });
    expect(restore).toEqual({ status: 200, result: { ok: true, data: restored } });
  });
});
