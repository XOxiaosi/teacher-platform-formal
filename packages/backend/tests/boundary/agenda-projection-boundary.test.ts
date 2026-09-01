import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendRoot = fileURLToPath(new URL('../..', import.meta.url));
const projectRoot = resolve(backendRoot, '../..');

function source(relativePath: string): string {
  const path = resolve(projectRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const targetFiles = [
  'packages/contracts/src/agenda.ts',
  'packages/backend/src/app/agenda/types.ts',
  'packages/backend/src/app/agenda/business-calendar.ts',
  'packages/backend/src/app/agenda/agenda-projection.ts',
  'packages/backend/src/app/agenda/agenda-query.ts',
  'packages/backend/src/app/agenda/index.ts',
  'packages/backend/src/app/routes/agenda.routes.ts',
] as const;

const ownerMethods = [
  ['packages/backend/src/features/scheduling/types.ts', 'listOverlappingSchedules'],
  ['packages/backend/src/features/memos/types.ts', 'listAgendaMemos'],
  ['packages/backend/src/features/pending-action/types.ts', 'listActivePendingActions'],
  ['packages/backend/src/features/students/types.ts', 'listOwnedStudentsByIds'],
] as const;

function agendaApplicationSource(): string {
  return targetFiles
    .filter((file) => file.includes('/backend/src/app/agenda/'))
    .map(source)
    .join('\n');
}

describe('A3 Agenda Projection结构边界', () => {
  it.each(targetFiles)('%s存在', (file) => {
    expect(existsSync(resolve(projectRoot, file))).toBe(true);
  });

  it('contracts index导出唯一Agenda共享协议', () => {
    expect(source('packages/contracts/src/index.ts')).toContain("export * from './agenda.js'");
  });

  it.each(ownerMethods)('%s声明owner窄读接口%s', (file, method) => {
    expect(source(file)).toContain(method);
  });

  it('composition声明Agenda依赖且core router挂载独立agenda router', () => {
    expect(source('packages/backend/src/app/composition/types.ts')).toContain('AgendaRouteDependencies');
    expect(source('packages/backend/src/app/routes/core.routes.ts')).toContain('createAgendaRouter');
  });

  it('共享Agenda协议保留D41 kind并禁止身份、token与任意路由字段', () => {
    const protocol = source('packages/contracts/src/agenda.ts');
    expect({
      exists: protocol.length > 0,
      hasKinds: ['lesson', 'memo', 'pending_action', 'payment_reminder', 'feedback_followup', 'custom_reminder']
        .every((kind) => protocol.includes(`'${kind}'`)),
      hasForbiddenField: /\b(?:teacherId|actionToken|parameters|content|route|payload)\??\s*:/.test(protocol),
    }).toEqual({ exists: true, hasKinds: true, hasForbiddenField: false });
  });

  it('Agenda应用模块不依赖Prisma、Express、React或渠道adapter', () => {
    const applicationSource = agendaApplicationSource();
    expect({
      exists: applicationSource.trim().length > 0,
      hasForbiddenDependency: /@prisma|PrismaClient|express|react|wechat/i.test(applicationSource),
    }).toEqual({ exists: true, hasForbiddenDependency: false });
  });
});
