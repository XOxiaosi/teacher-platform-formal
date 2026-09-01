import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../../src');

function read(relativePath: string): string {
  try {
    return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

describe('Schedule reschedule command static boundaries', () => {
  it('production factory使用raw transaction、数据库clock、显式ChangeLog和sentinel回滚', () => {
    const source = read('app/use-cases/reschedule-lesson/index.ts');
    expect(source).toContain('rawPrisma.$transaction');
    expect(source).toContain('createDatabaseTrustedClock');
    expect(source).toContain('createChangelogService');
    expect(source).toContain('createScheduleRescheduler');
    expect(source).toMatch(/if \(!result\.ok\) throw new \w+Rollback/);
  });

  it('owner使用teacher+id+before token+planned lesson的updateMany CAS且原记录只写状态与token及其shadow', () => {
    const source = read('features/scheduling/schedule-rescheduler.ts');
    expect(source).toContain('prisma.schedule.updateMany');
    expect(source).toMatch(/where:\s*\{[\s\S]*teacherId: input\.teacherId,[\s\S]*id: input\.scheduleId,[\s\S]*updatedAtTs: before\.updatedAtTs,[\s\S]*status: 'planned',[\s\S]*type: 'lesson'/);
    expect(source).toContain("data: { status: 'rescheduled', updatedAtTs: token }");
    expect(source).not.toContain('prisma.schedule.update({');
    expect(source).not.toMatch(/data:\s*\{[^}]*parentId[^}]*\}\s*\}\);/);
  });

  it('replacement parent指原记录，复制白名单上下文并显式写可信createdAt/updatedAt', () => {
    const source = read('features/scheduling/schedule-rescheduler.ts');
    expect(source).toContain('parentId: before.id');
    expect(source).toContain('studentId: before.studentId');
    expect(source).toContain('type: before.type');
    expect(source).toContain('title: before.title');
    expect(source).toContain('confidence: before.confidence');
    expect(source).toContain('sourceInput: before.sourceInput');
    expect(source).toContain('createdAtTs: token');
    expect(source).toContain('updatedAtTs: token');
    expect(source).not.toContain('parentId: before.parentId');
  });

  it('冲突查询锁定同teacher active严格重叠、排除replacement并确定排序', () => {
    const source = read('features/scheduling/schedule-rescheduler.ts');
    expect(source).toContain("status: { in: ['planned', 'extra'] }");
    expect(source).toContain('scheduledStartTs: { lt: input.replacement.scheduledEnd }');
    expect(source).toContain('scheduledEndTs: { gt: input.replacement.scheduledStart }');
    expect(source).toContain('id: { not: created.id }');
    expect(source).toMatch(/orderBy:\s*\[[\s\S]*scheduledStartTs: 'asc'[\s\S]*scheduledEndTs: 'asc'[\s\S]*id: 'asc'/);
  });

  it('纯应用use-case不import Prisma、不直接写数据库，审计快照来自owner事实', () => {
    const source = read('app/use-cases/reschedule-lesson/reschedule-lesson-use-case.ts');
    expect(source).not.toContain('@prisma/client');
    expect(source).not.toMatch(/prisma\.[A-Za-z]/);
    expect(source).not.toMatch(/recordChange\([^)]*command\.(before|after)/);
    expect(source).toContain('rescheduled.value.beforeOriginal');
    expect(source).toContain('rescheduled.value.replacement');
  });

  it('legacy Scheduling service与状态机保持独立，新命令位于独立owner', () => {
    const legacy = read('features/scheduling/schedule-service.ts');
    const stateMachine = read('features/scheduling/state-machine.ts');
    const index = read('features/scheduling/index.ts');
    expect(legacy).toContain('async createSchedule(input)');
    expect(legacy).toContain('async updateScheduleStatus(input)');
    expect(legacy).toContain('async cancelSchedule(input)');
    expect(legacy).not.toContain('rescheduleLesson');
    expect(stateMachine).toContain('validateTransition');
    expect(index).toContain("export { createScheduleService } from './schedule-service.js'");
    expect(index).toContain("export { createScheduleRescheduler } from './schedule-rescheduler.js'");
  });
});
