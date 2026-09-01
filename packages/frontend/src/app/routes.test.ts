import { describe, expect, it } from 'vitest';
import * as routeExports from './routes';
import { auxiliaryRoutes, isPublicRoute, primaryRoutes, resolveAppRoute } from './routes';

type ParsedRouteValue =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: string };

interface A4RouteExports {
  parseSingleRouteQuery?: (route: string, key: string) => ParsedRouteValue;
  parseWeekStartRouteQuery?: (route: string) => ParsedRouteValue;
  parseStudentRouteId?: (route: string) => ParsedRouteValue;
}

const a4Routes = routeExports as unknown as A4RouteExports;

describe('P5 route registry', () => {
  it('按批准顺序提供六个主导航与五个辅助导航', () => {
    expect(primaryRoutes.map(({ path, label }) => ({ path, label }))).toEqual([
      { path: '/agent', label: 'Agent' },
      { path: '/today', label: '今日' },
      { path: '/students', label: '学生' },
      { path: '/schedules', label: '日程' },
      { path: '/feedback', label: '家长反馈' },
      { path: '/finance', label: '财务' },
    ]);
    expect(auxiliaryRoutes.map(({ path, label }) => ({ path, label }))).toEqual([
      { path: '/changelog', label: '变更记录' },
      { path: '/settings', label: '设置' },
      { path: '/settings/llm', label: 'LLM 配置' },
      { path: '/settings/privacy', label: '隐私与数据' },
      { path: '/feedback-submit', label: '用户反馈' },
    ]);
  });

  it('解析旧入口并将未知路径安全回退到 /agent', () => {
    expect(resolveAppRoute('/')).toBe('/agent');
    expect(resolveAppRoute('/ai-input')).toBe('/agent');
    expect(resolveAppRoute('/daily-review')).toBe('/today?view=review');
    expect(resolveAppRoute('/payments')).toBe('/finance');
    expect(resolveAppRoute('/students')).toBe('/students');
    expect(resolveAppRoute('/settings/llm')).toBe('/settings/llm');
    expect(resolveAppRoute('/settings/privacy')).toBe('/settings/privacy');
    expect(resolveAppRoute('/unknown')).toBe('/agent');
  });

  it('isPublicRoute 只放行 /login /register（含 query 尾随）', () => {
    expect(isPublicRoute('/login')).toBe(true);
    expect(isPublicRoute('/register')).toBe(true);
    expect(isPublicRoute('/login?next=/agent')).toBe(true);
    expect(isPublicRoute('/register#top')).toBe(true);
    for (const route of ['/agent', '/today', '/students', '/schedules', '/feedback', '/finance', '/changelog', '/settings', '/settings/llm', '/settings/privacy']) {
      expect(isPublicRoute(route)).toBe(false);
    }
  });

  it('resolveAppRoute 放行 /login /register，不再回退到 /agent', () => {
    expect(resolveAppRoute('/login')).toBe('/login');
    expect(resolveAppRoute('/register')).toBe('/register');
    expect(resolveAppRoute('/login?next=/agent')).toBe('/login?next=/agent');
  });

  it('单值query解码合法值并拒绝重复、空值、畸形编码和超长值', () => {
    expect(a4Routes.parseSingleRouteQuery).toBeTypeOf('function');
    if (!a4Routes.parseSingleRouteQuery) return;

    expect(a4Routes.parseSingleRouteQuery('/today', 'focusMemo')).toEqual({ kind: 'missing' });
    expect(a4Routes.parseSingleRouteQuery('/today?focusMemo=memo%2F1', 'focusMemo')).toEqual({
      kind: 'valid',
      value: 'memo/1',
    });
    expect(a4Routes.parseSingleRouteQuery('/today?focusMemo=a&focusMemo=b', 'focusMemo')).toEqual({ kind: 'invalid' });
    expect(a4Routes.parseSingleRouteQuery('/today?focusMemo=', 'focusMemo')).toEqual({ kind: 'invalid' });
    expect(a4Routes.parseSingleRouteQuery('/today?focusMemo=%E0%A4%A', 'focusMemo')).toEqual({ kind: 'invalid' });
    expect(a4Routes.parseSingleRouteQuery(`/today?focusMemo=${'a'.repeat(129)}`, 'focusMemo')).toEqual({ kind: 'invalid' });
  });

  it('weekStart只接受严格合法周一BusinessDate', () => {
    expect(a4Routes.parseWeekStartRouteQuery).toBeTypeOf('function');
    if (!a4Routes.parseWeekStartRouteQuery) return;

    expect(a4Routes.parseWeekStartRouteQuery('/schedules')).toEqual({ kind: 'missing' });
    expect(a4Routes.parseWeekStartRouteQuery('/schedules?weekStart=2030-07-22')).toEqual({
      kind: 'valid',
      value: '2030-07-22',
    });
    for (const route of [
      '/schedules?weekStart=2030-07-23',
      '/schedules?weekStart=2030-7-22',
      '/schedules?weekStart=2030-02-30',
      '/schedules?weekStart=2030-07-22&weekStart=2030-07-29',
    ]) {
      expect(a4Routes.parseWeekStartRouteQuery(route)).toEqual({ kind: 'invalid' });
    }
  });

  it('保留单segment Student对象路径并安全解码ID', () => {
    expect(a4Routes.parseStudentRouteId).toBeTypeOf('function');
    if (!a4Routes.parseStudentRouteId) return;

    expect(resolveAppRoute('/students/student%2F1?tab=lessons&focus=lesson-1')).toBe(
      '/students/student%2F1?tab=lessons&focus=lesson-1',
    );
    expect(a4Routes.parseStudentRouteId('/students/student%2F1?tab=lessons')).toEqual({
      kind: 'valid',
      value: 'student/1',
    });
    expect(a4Routes.parseStudentRouteId('/students')).toEqual({ kind: 'missing' });
    expect(a4Routes.parseStudentRouteId('/students/%E0%A4%A')).toEqual({ kind: 'invalid' });
    expect(resolveAppRoute('/students/a/b')).toBe('/agent');
  });
});
