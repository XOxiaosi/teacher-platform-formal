/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendRoot = resolve(process.cwd());

function source(relativePath: string): string {
  const path = resolve(frontendRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const targetFiles = [
  'src/api/agenda.ts',
  'src/shared/object-reference-routing.ts',
  'src/features/agenda/agenda-time.ts',
  'src/features/agenda/agenda-view-model.ts',
  'src/features/agenda/AgendaItemView.tsx',
  'src/features/agent/AgentTodayContext.tsx',
  'src/features/schedules/week-schedule.ts',
  'src/features/schedules/WeekScheduleView.tsx',
] as const;

describe('A4 Agenda UI结构边界', () => {
  it.each(targetFiles)('%s存在', (file) => {
    expect(existsSync(resolve(frontendRoot, file))).toBe(true);
  });

  it('Today页面只读取Agenda且不再读取浏览器当前时间或旧Dashboard数据源', () => {
    const dashboard = source('src/features/dashboard/DashboardPage.tsx');
    expect({
      usesAgenda: /api\/agenda/.test(dashboard),
      usesLegacySources: /listStudents|listSchedules|listPayments|saveRawInput|isTodaySchedule/.test(dashboard),
      usesBrowserNow: /new Date\s*\(\s*\)|Date\.now\s*\(/.test(dashboard),
    }).toEqual({
      usesAgenda: true,
      usesLegacySources: false,
      usesBrowserNow: false,
    });
  });

  it('App消费weekStart、focusMemo和受控Student对象路径', () => {
    const app = source('src/app/App.tsx');
    const routes = source('src/app/routes.ts');
    expect({
      hasWeekStart: app.includes('weekStart'),
      hasFocusMemo: app.includes('focusMemo'),
      supportsStudentObjectPath: app.includes('parseStudentRouteId') && routes.includes('parseStudentRouteId'),
    }).toEqual({
      hasWeekStart: true,
      hasFocusMemo: true,
      supportsStudentObjectPath: true,
    });
  });

  it('A4应用模块存在且不依赖backend、Prisma、任意HTML或浏览器当前时间', () => {
    const application = targetFiles.map(source).join('\n');
    expect({
      exists: application.trim().length > 0,
      hasForbiddenDependency: /packages\/backend|@prisma|PrismaClient/.test(application),
      hasUnsafeHtml: /dangerouslySetInnerHTML/.test(application),
      hasBrowserNow: /new Date\s*\(\s*\)|Date\.now\s*\(/.test(application),
    }).toEqual({
      exists: true,
      hasForbiddenDependency: false,
      hasUnsafeHtml: false,
      hasBrowserNow: false,
    });
  });
});
