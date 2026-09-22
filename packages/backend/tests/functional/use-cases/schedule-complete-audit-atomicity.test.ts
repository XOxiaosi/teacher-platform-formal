import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, internalError } from '@teacher-platform/contracts';
import { createScheduleCompleteUseCase } from '../../../src/app/use-cases/schedule-complete/index.js';
import {
  createChangelogService,
  withChangelog,
  type ChangelogFactory,
} from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const changelogQueryService = createChangelogService(prisma, cipher);
const TEACHER_ID = 'test-teacher-schedule-complete-audit';
const AUDIT_SECRET = 'schedule complete audit failure detail';

function failingAuditAt(failureAt: number): ChangelogFactory {
  return (client) => {
    const real = createChangelogService(client, cipher);
    let callCount = 0;
    return {
      async recordChange(input) {
        callCount += 1;
        if (callCount === failureAt) return err(internalError(AUDIT_SECRET));
        return real.recordChange(input);
      },
    };
  };
}

async function cleanup() {
  await prisma.changeLog.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.scheduleCompletionSnapshot.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lessonLedgerEntry.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.lesson.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.schedule.deleteMany({ where: { teacherId: TEACHER_ID } });
  await prisma.student.deleteMany({ where: { teacherId: TEACHER_ID } });
}

async function createFixture() {
  const student = await prisma.student.create({
    data: {
      teacherId: TEACHER_ID,
      name: '完成课程审计学生',
      grade: '高二',
    },
  });
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      type: 'lesson',
      title: '物理复习课',
      scheduledStartTs: new Date('2032-02-03T04:00:00Z'),
      scheduledEndTs: new Date('2032-02-03T05:00:00Z'),
      status: 'planned',
    },
  });
  return { student, schedule };
}

async function auditLogs() {
  const result = await changelogQueryService.queryChangeLogs({
    teacherId: TEACHER_ID,
    pageSize: 20,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('query changelog failed');
  return result.value.items;
}

async function expectBusinessRolledBack(scheduleId: string) {
  const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
  expect(schedule.status).toBe('planned');
  expect(await prisma.lesson.count({ where: { scheduleId } })).toBe(0);
  expect(await prisma.changeLog.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
}

beforeEach(cleanup);
afterEach(cleanup);

describe('schedule-complete explicit audit atomicity', () => {
  it('raw tenant client 成功后只写入日程与课次审计，不写扣课流水或完成快照', async () => {
    const { schedule } = await createFixture();
    const useCase = createScheduleCompleteUseCase(prisma);

    const result = await useCase.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: schedule.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const logs = await auditLogs();
    expect(logs).toHaveLength(2);
    const scheduleLog = logs.find((item) => item.targetType === 'Schedule');
    const lessonLog = logs.find((item) => item.targetType === 'Lesson');
    expect(scheduleLog).toMatchObject({ action: 'update', targetId: schedule.id, source: 'system' });
    expect(scheduleLog?.before?.status).toBe('planned');
    expect(scheduleLog?.after?.status).toBe('completed');
    expect(Object.keys(scheduleLog?.after ?? {}).sort()).toEqual([
      'classFormat', 'confidence', 'createdAtTs', 'id', 'location', 'operationalNote',
      'parentId', 'participantIds', 'pendingFields', 'scheduledEndTs', 'scheduledStartTs',
      'sourceInput', 'status', 'studentId', 'teacherId', 'type', 'updatedAtTs',
    ]);
    expect(lessonLog).toMatchObject({
      action: 'create',
      targetId: result.value.lesson.id,
      before: null,
      source: 'system',
    });
    expect(Object.keys(lessonLog?.after ?? {}).sort()).toEqual([
      'createdAtTs', 'dateTs', 'homework', 'id', 'progress', 'scheduleId', 'sourceNoteId',
      'status', 'studentId', 'studentState', 'teacherId', 'teacherNote', 'updatedAtTs',
    ]);
    expect(await prisma.lessonLedgerEntry.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
    expect(await prisma.scheduleCompletionSnapshot.count({ where: { teacherId: TEACHER_ID } })).toBe(0);
  });

  it('extended client 下 suppression 保证成功时合计恰好两条日志', async () => {
    const { schedule } = await createFixture();
    const extended = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    ) as unknown as PrismaClient;
    const useCase = createScheduleCompleteUseCase(extended);

    const result = await useCase.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: schedule.id,
    });

    expect(result.ok).toBe(true);
    expect(await auditLogs()).toHaveLength(2);
  });

  it('第一条审计失败时回滚两项业务写且不泄漏底层错误', async () => {
    const { schedule } = await createFixture();
    const options = {
      getClient: async () => prisma,
      changelogFactory: failingAuditAt(1),
    };
    const useCase = createScheduleCompleteUseCase(options);

    const result = await useCase.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: schedule.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(AUDIT_SECRET);
    await expectBusinessRolledBack(schedule.id);
  });

  it('第二条审计失败时回滚第一条日志与两项业务写', async () => {
    const { schedule } = await createFixture();
    const options = {
      getClient: async () => prisma,
      changelogFactory: failingAuditAt(2),
    };
    const useCase = createScheduleCompleteUseCase(options);

    const result = await useCase.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: schedule.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(AUDIT_SECRET);
    await expectBusinessRolledBack(schedule.id);
  });

  it('Lesson 数据库写失败时回滚 Schedule 且不留下旧自动审计', async () => {
    const { schedule } = await createFixture();
    const withAudit = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    );
    const faulting = withAudit.$extends({
      query: {
        lesson: {
          async create() {
            throw new Error('forced lesson database failure');
          },
        },
      },
    }) as unknown as PrismaClient;
    const useCase = createScheduleCompleteUseCase(faulting);

    await expect(useCase.completeSchedule({
      teacherId: TEACHER_ID,
      scheduleId: schedule.id,
    })).rejects.toThrow('forced lesson database failure');

    await expectBusinessRolledBack(schedule.id);
  });

  it('复用 outer TransactionClient，外层回滚后业务与两条日志都为零', async () => {
    const { schedule } = await createFixture();
    const extended = withChangelog(
      prisma,
      createChangelogService(prisma, cipher),
    ) as unknown as PrismaClient;

    await expect(extended.$transaction(async (tx) => {
      const options = {
        getClient: async () => tx as unknown as PrismaClient,
      };
      const useCase = createScheduleCompleteUseCase(options);
      const result = await useCase.completeSchedule({
        teacherId: TEACHER_ID,
        scheduleId: schedule.id,
      });
      expect(result.ok).toBe(true);
      throw new Error('force outer rollback');
    })).rejects.toThrow('force outer rollback');

    await expectBusinessRolledBack(schedule.id);
  });

  it('复用 outer TransactionClient 时审计 Err 必须向外抛出以强制外层回滚', async () => {
    const { schedule } = await createFixture();

    await expect(prisma.$transaction(async (tx) => {
      const options = {
        getClient: async () => tx as unknown as PrismaClient,
        changelogFactory: failingAuditAt(2),
      };
      const useCase = createScheduleCompleteUseCase(options);
      return useCase.completeSchedule({
        teacherId: TEACHER_ID,
        scheduleId: schedule.id,
      });
    })).rejects.toThrow('schedule-complete transaction rollback');

    await expectBusinessRolledBack(schedule.id);
  });
});
