import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createDatabaseConfirmableActionRegistry } from '../../../src/app/confirmation/database-confirmable-action-registry.js';
import {
  COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE,
  LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE,
} from '../../../src/app/policies/completion-entrypoint-gate.js';
import { createIsolatedPostgres, type IsolatedPostgres } from '../../helpers/isolated-postgres.js';

const TEACHER_A = 'test-database-executor-teacher-a';
const TEACHER_B = 'test-database-executor-teacher-b';

let database: IsolatedPostgres;
let prisma: PrismaClient;

async function seedObjects() {
  const student = await prisma.student.create({
    data: { teacherId: TEACHER_A, name: '测试学生', grade: '高一' },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_A,
      studentId: student.id,
      type: 'lesson',
      title: '测试课',
      scheduledStartTs: new Date('2030-01-01T08:00:00.000Z'),
      scheduledEndTs: new Date('2030-01-01T09:00:00.000Z'),
    },
  });
  const lesson = await prisma.lesson.create({
    data: {
      teacherId: TEACHER_A,
      studentId: student.id,
      scheduleId: schedule.id,
      dateTs: new Date('2030-01-01T08:00:00.000Z'),
    },
  });
  return { student, schedule, lesson };
}

beforeAll(async () => {
  database = await createIsolatedPostgres();
  prisma = database.prisma;
}, 60_000);

afterAll(async () => {
  await database.cleanup();
}, 30_000);

beforeEach(async () => {
  await prisma.changeLog.deleteMany();
  await prisma.lesson.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.student.deleteMany();
});

describe('database ConfirmableActionRegistry', () => {
  it.each([
    {
      actionName: 'scheduling.cancel' as const,
      targetType: 'Schedule' as const,
      objectKey: 'schedule' as const,
      statusField: 'status' as const,
      targetStatus: 'cancelled',
      parameters: (id: string) => ({ scheduleId: id }),
    },
    {
      actionName: 'students.updateStatus' as const,
      targetType: 'Student' as const,
      objectKey: 'student' as const,
      statusField: 'currentStatus' as const,
      targetStatus: 'paused',
      parameters: (id: string) => ({ studentId: id, status: 'paused' }),
    },
  ])('$actionName 通过 owner service 更新并写一条 ChangeLog', async (scenario) => {
    const objects = await seedObjects();
    const target = objects[scenario.objectKey];

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get(scenario.actionName);
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: scenario.targetType, id: target.id },
        parameters: scenario.parameters(target.id),
      });
    });

    expect(result).toMatchObject({
      ok: true,
      value: { references: [{ type: scenario.targetType, id: target.id }] },
    });
    const persisted = scenario.objectKey === 'student'
      ? await prisma.student.findUniqueOrThrow({ where: { id: target.id } })
      : scenario.objectKey === 'lesson'
        ? await prisma.lesson.findUniqueOrThrow({ where: { id: target.id } })
        : await prisma.schedule.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted[scenario.statusField]).toBe(scenario.targetStatus);
    expect(await prisma.changeLog.count({
      where: { teacherId: TEACHER_A, targetId: target.id },
    })).toBe(1);
  });

  it.each([
    ['scheduling.complete', 'Schedule', 'scheduleId', COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, 'completion', (id: string) => ({ scheduleId: id })],
    ['lessons.updateStatus', 'Lesson', 'lessonId', LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE, 'lessonStatus', (id: string) => ({ lessonId: id, status: 'attended' })],
  ] as const)('%s 的旧 PendingAction executor 不改任何业务记录', async (actionName, targetType, idField, message, field, parameters) => {
    const objects = await seedObjects();
    const target = idField === 'scheduleId' ? objects.schedule : objects.lesson;
    const before = {
      schedule: (await prisma.schedule.findUniqueOrThrow({ where: { id: objects.schedule.id } })).status,
      lesson: (await prisma.lesson.findUniqueOrThrow({ where: { id: objects.lesson.id } })).status,
    };

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get(actionName);
      if (!executor.ok) return executor;
      return executor.value.execute({
        pendingActionId: `legacy-${actionName}`,
        teacherId: TEACHER_A,
        target: { type: targetType, id: target.id },
        parameters: parameters(target.id),
      });
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message, field },
    });
    expect((await prisma.schedule.findUniqueOrThrow({ where: { id: objects.schedule.id } })).status).toBe(before.schedule);
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: objects.lesson.id } })).status).toBe(before.lesson);
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('跨 teacher 返回 NOT_FOUND，不修改对象且不写 ChangeLog', async () => {
    const { student } = await seedObjects();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_B,
        target: { type: 'Student', id: student.id },
        parameters: { studentId: student.id, status: 'paused' },
      });
    });

    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '学生不存在' } });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStatus).toBe('active');
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('target 与 parameters 不一致时拒绝执行', async () => {
    const { student } = await seedObjects();

    const result = await prisma.$transaction(async (tx) => {
      const registry = createDatabaseConfirmableActionRegistry(tx);
      const executor = registry.get('students.updateStatus');
      if (!executor.ok) return executor;
      return executor.value.execute({
        teacherId: TEACHER_A,
        target: { type: 'Student', id: student.id },
        parameters: { studentId: 'other-student', status: 'paused' },
      });
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'parameters' } });
    expect(await prisma.changeLog.count()).toBe(0);
  });
});
