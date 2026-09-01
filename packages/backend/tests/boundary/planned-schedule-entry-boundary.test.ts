import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composition = readFileSync(
  resolve(__dirname, '../../src/app/composition/core-route-dependencies.ts'),
  'utf8',
);
const scheduleRoutes = readFileSync(resolve(__dirname, '../../src/app/routes/schedules.routes.ts'), 'utf8');
const tools = readFileSync(resolve(__dirname, '../../src/app/tools/register-p0-write-tools.ts'), 'utf8');
const useCase = readFileSync(
  resolve(__dirname, '../../src/app/use-cases/create-planned-schedule/create-planned-schedule-use-case.ts'),
  'utf8',
);

describe('P6-B02 planned schedule 统一入口边界', () => {
  it('HTTP route 通过 create-planned-schedule use-case，不跨层复用 Tool parser', () => {
    expect(composition).toContain('createPlannedScheduleUseCase');
    expect(scheduleRoutes).toContain('dependencies.plannedSchedules.create({');
    expect(scheduleRoutes).not.toContain('parseDate(req.body.scheduledStart) as Date');
    expect(scheduleRoutes).not.toContain('tool-arg-parsers');
  });

  it('scheduling.create Tool 通过同一 use-case，不保留第二套 strict time 校验', () => {
    expect(tools).toContain("createPlannedScheduleUseCase");
    expect(tools).toContain('plannedSchedules.create({');
    expect(tools).not.toContain('parseRfc3339InstantArg');
    expect(tools).not.toContain('scheduledStart <= trustedNow.value');
  });

  it('应用 use-case 不依赖 Express、route、ToolRegistry 或 Prisma 实现', () => {
    expect(useCase).not.toMatch(/from ['"].*routes/);
    expect(useCase).not.toMatch(/from ['"].*tools/);
    expect(useCase).not.toContain('express');
    expect(useCase).not.toContain('ToolRegistry');
    expect(useCase).not.toContain('PrismaClient');
  });
});
