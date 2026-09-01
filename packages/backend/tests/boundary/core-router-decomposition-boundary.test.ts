import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceRoot = resolve(backendRoot, 'src');
const coreRouterPath = resolve(sourceRoot, 'app/routes/core.routes.ts');
const coreRouterSource = readFileSync(coreRouterPath, 'utf8');

const routeFiles = [
  'students.routes.ts',
  'schedules.routes.ts',
  'payments.routes.ts',
  'daily-review.routes.ts',
  'ai-input.routes.ts',
  'agent.routes.ts',
] as const;

const compositionFiles = [
  'types.ts',
  'core-route-dependencies.ts',
] as const;

const concreteDependencyPattern = /\bnew\s+PrismaClient\b|\bprisma\.[A-Za-z]|\bcreate[A-Za-z]+(?:Service|UseCase)\s*\(|from ['"](?:\.\.\/\.\.\/features|\.\.\/use-cases|\.\.\/\.\.\/shared)\//;

describe('A1 核心路由拆分边界', () => {
  it.each(routeFiles)('routes/%s 存在且不直接访问 Prisma 或构造业务服务', (file) => {
    const path = resolve(sourceRoot, 'app/routes', file);
    const exists = existsSync(path);
    const source = exists ? readFileSync(path, 'utf8') : '';
    expect({ exists, clean: exists && !concreteDependencyPattern.test(source) }).toEqual({
      exists: true,
      clean: true,
    });
  });

  it.each(compositionFiles)('composition/%s 存在', (file) => {
    expect(existsSync(resolve(sourceRoot, 'app/composition', file))).toBe(true);
  });

  it('core.routes.ts 不超过 120 行', () => {
    expect(coreRouterSource.split('\n').length).toBeLessThanOrEqual(120);
  });

  it('core.routes.ts 不再直接 import feature、use-case 或 shared 具体实现', () => {
    expect(coreRouterSource).not.toMatch(/from ['"](?:\.\.\/use-cases|\.\.\/\.\.\/features|\.\.\/\.\.\/shared)\//);
  });

  it('core.routes.ts 不再直接注册 HTTP endpoint', () => {
    expect(coreRouterSource).not.toMatch(/\brouter\.(?:get|post|put|patch|delete)\s*\(/);
  });

  it('core.routes.ts 通过 createCoreRouteDependencies 获取装配结果', () => {
    expect(coreRouterSource).toContain('createCoreRouteDependencies');
  });

  it('core.routes.ts 挂载六个窄路由工厂', () => {
    const expectedFactories = [
      'createStudentRouter',
      'createScheduleRouter',
      'createPaymentRouter',
      'createDailyReviewRouter',
      'createAiInputRouter',
      'createAgentRouter',
    ];
    const missing = expectedFactories.filter((factory) => !coreRouterSource.includes(factory));
    expect(missing).toEqual([]);
  });
});
