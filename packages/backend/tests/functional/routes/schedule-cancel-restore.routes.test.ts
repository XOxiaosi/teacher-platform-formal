import type { Request, Response } from 'express';
import { ok, err, notFound } from '@teacher-platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleRouteDependencies } from '../../../src/app/composition/types.js';
import { createScheduleRouter } from '../../../src/app/routes/schedules.routes.js';

function createDependencies() {
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

async function invokeRoute(options: {
  dependencies: ScheduleRouteDependencies;
  method: string;
  routePath: string;
  params: Record<string, string>;
  teacherId?: string;
}) {
  const router = createScheduleRouter(options.dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === options.routePath && candidate.route.methods[options.method]
  ));
  if (!layer?.route) throw new Error(`route not registered: ${options.method} ${options.routePath}`);

  let statusCode = 200;
  let responseBody: unknown;
  const req = {
    params: options.params,
    // P0 IDOR 修复：身份来自 requireAuth 注入的 req.teacherId（不再读 x-teacher-id header）
    teacherId: options.teacherId,
  } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      responseBody = value;
      return this;
    },
  } as Response;
  await layer.route!.stack[0]!.handle(req, res);
  return { statusCode, responseBody };
}

describe('D49 schedules cancel/restore routes', () => {
  it('POST /schedules/:scheduleId/cancel 传递 teacherId 并返回结果', async () => {
    const dependencies = createDependencies();
    dependencies.schedules.cancelSchedule = vi.fn(async () => ok({ id: 'sch-1', status: 'cancelled' } as never));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      method: 'post',
      routePath: '/schedules/:scheduleId/cancel',
      params: { scheduleId: 'sch-1' },
      teacherId: 'teacher-a',
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(dependencies.schedules.cancelSchedule).toHaveBeenCalledWith({
      teacherId: 'teacher-a',
      scheduleId: 'sch-1',
    });
  });

  it('POST /schedules/:scheduleId/restore 传递 teacherId 并返回结果', async () => {
    const dependencies = createDependencies();
    dependencies.schedules.restoreSchedule = vi.fn(async () => ok({ id: 'sch-1', status: 'planned' } as never));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      method: 'post',
      routePath: '/schedules/:scheduleId/restore',
      params: { scheduleId: 'sch-1' },
      teacherId: 'teacher-a',
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toMatchObject({ ok: true, data: { status: 'planned' } });
    expect(dependencies.schedules.restoreSchedule).toHaveBeenCalledWith({
      teacherId: 'teacher-a',
      scheduleId: 'sch-1',
    });
  });

  it('缺少 x-teacher-id 时返回教师错误', async () => {
    const dependencies = createDependencies();

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      method: 'post',
      routePath: '/schedules/:scheduleId/cancel',
      params: { scheduleId: 'sch-1' },
    });

    expect(statusCode).toBe(400);
    expect(responseBody).toMatchObject({ ok: false });
    expect(dependencies.schedules.cancelSchedule).not.toHaveBeenCalled();
  });

  it('cancel 返回 NOT_FOUND 时透传 404', async () => {
    const dependencies = createDependencies();
    dependencies.schedules.cancelSchedule = vi.fn(async () => err(notFound('日程不存在')));

    const { statusCode, responseBody } = await invokeRoute({
      dependencies,
      method: 'post',
      routePath: '/schedules/:scheduleId/cancel',
      params: { scheduleId: 'missing' },
      teacherId: 'teacher-a',
    });

    expect(statusCode).toBe(404);
    expect(responseBody).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
