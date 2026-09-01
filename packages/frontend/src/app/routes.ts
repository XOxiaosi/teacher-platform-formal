export interface AppRoute {
  path: string;
  label: string;
  shortLabel: string;
}

export type ParsedRouteValue =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: string };

export const primaryRoutes: AppRoute[] = [
  { path: '/agent', label: 'Agent', shortLabel: 'Agent' },
  { path: '/today', label: '今日', shortLabel: '今日' },
  { path: '/students', label: '学生', shortLabel: '学生' },
  { path: '/schedules', label: '日程', shortLabel: '日程' },
  { path: '/feedback', label: '家长反馈', shortLabel: '反馈' },
  { path: '/finance', label: '财务', shortLabel: '财务' },
];

export const auxiliaryRoutes: AppRoute[] = [
  { path: '/changelog', label: '变更记录', shortLabel: '变更' },
  { path: '/settings', label: '设置', shortLabel: '设置' },
  { path: '/settings/llm', label: 'LLM 配置', shortLabel: 'LLM' },
  { path: '/settings/privacy', label: '隐私与数据', shortLabel: '隐私' },
  { path: '/feedback-submit', label: '用户反馈', shortLabel: '意见' },
];

export const publicRoutes: AppRoute[] = [
  { path: '/login', label: '登录', shortLabel: '登录' },
  { path: '/register', label: '注册', shortLabel: '注册' },
];

const aliases: Record<string, string> = {
  '/': '/agent',
  '/ai-input': '/agent',
  '/daily-review': '/today?view=review',
  '/payments': '/finance',
};

const canonicalPaths = new Set([...primaryRoutes, ...auxiliaryRoutes].map((route) => route.path));
const publicPaths = new Set(publicRoutes.map((route) => route.path));
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_ROUTE_VALUE_LENGTH = 128;

export function routePathname(route: string): string {
  return route.split(/[?#]/)[0] || '/agent';
}

/** /login /register 等无需登录即可访问的路由。 */
export function isPublicRoute(route: string): boolean {
  return publicPaths.has(routePathname(route));
}

export function resolveAppRoute(route: string): string {
  const pathname = routePathname(route);
  if (aliases[pathname]) return aliases[pathname];
  if (canonicalPaths.has(pathname)) return route;
  if (publicPaths.has(pathname)) return route;
  return parseStudentRouteId(route).kind === 'valid' ? route : '/agent';
}

export function parseSingleRouteQuery(route: string, key: string): ParsedRouteValue {
  const questionIndex = route.indexOf('?');
  if (questionIndex === -1) return { kind: 'missing' };
  const hashIndex = route.indexOf('#', questionIndex + 1);
  const query = route.slice(questionIndex + 1, hashIndex === -1 ? undefined : hashIndex);
  const values: string[] = [];

  for (const segment of query.split('&')) {
    if (!segment) continue;
    const equalsIndex = segment.indexOf('=');
    const rawKey = equalsIndex === -1 ? segment : segment.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? '' : segment.slice(equalsIndex + 1);
    const decodedKey = decodeRouteValue(rawKey);
    if (decodedKey !== key) continue;
    const decodedValue = decodeRouteValue(rawValue);
    if (decodedValue === null) return { kind: 'invalid' };
    values.push(decodedValue);
  }

  if (values.length === 0) return { kind: 'missing' };
  if (values.length !== 1 || !isSafeRouteValue(values[0])) return { kind: 'invalid' };
  return { kind: 'valid', value: values[0] };
}

export function parseWeekStartRouteQuery(route: string): ParsedRouteValue {
  const parsed = parseSingleRouteQuery(route, 'weekStart');
  if (parsed.kind !== 'valid') return parsed;
  const match = BUSINESS_DATE_PATTERN.exec(parsed.value);
  if (!match) return { kind: 'invalid' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(epoch)) return { kind: 'invalid' };
  const date = new Date(epoch);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCDay() !== 1
  ) return { kind: 'invalid' };

  return parsed;
}

export function parseStudentRouteId(route: string): ParsedRouteValue {
  const match = /^\/students\/([^/]+)$/.exec(routePathname(route));
  if (!match) return { kind: 'missing' };
  const value = decodeRouteValue(match[1]);
  return value !== null && isSafeRouteValue(value)
    ? { kind: 'valid', value }
    : { kind: 'invalid' };
}

function decodeRouteValue(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function isSafeRouteValue(value: string): boolean {
  return value.trim().length > 0
    && value.length <= MAX_ROUTE_VALUE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}
