import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { err, ok, validationError } from '@teacher-platform/contracts';
import { runFormalLessonTransaction } from '../../../src/features/scheduling/schedule-create-helpers.js';
import type { CreateScheduleInput } from '../../../src/features/scheduling/types.js';

function serializationFailure() {
  return new Prisma.PrismaClientKnownRequestError('serialization failure', {
    code: 'P2034',
    clientVersion: '6.19.3',
  });
}

function input(): CreateScheduleInput {
  return {
    teacherId: 'teacher-p2034-test',
    clientRequestId: 'schedule-p2034-test-0001',
    participantIds: ['student-p2034-test'],
    type: 'lesson',
    scheduledStart: new Date('2035-07-24T11:00:00.000Z'),
    scheduledEnd: new Date('2035-07-24T12:00:00.000Z'),
  };
}

function fakePrisma(
  transaction: (callback: (tx: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>,
  options: { replay?: unknown; conflict?: unknown } = {},
) {
  return {
    $transaction: transaction,
    schedule: {
      findFirst: async (args: { where?: { clientRequestId?: string } }) => (
        args.where?.clientRequestId ? options.replay ?? null : options.conflict ?? null
      ),
    },
    recurrenceRule: { findMany: async () => [] },
  } as never;
}

function replayRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'replayed-schedule',
    teacherId: 'teacher-p2034-test',
    studentId: null,
    type: 'lesson',
    title: '',
    locationCiphertext: null,
    classFormat: null,
    operationalNoteCiphertext: null,
    scheduledStartTs: new Date('2035-07-24T11:00:00.000Z'),
    scheduledEndTs: new Date('2035-07-24T12:00:00.000Z'),
    status: 'planned',
    confidence: null,
    pendingFields: null,
    sourceInput: null,
    parentId: null,
    createdAtTs: new Date('2035-07-23T00:00:00.000Z'),
    updatedAtTs: new Date('2035-07-23T00:00:00.000Z'),
    clientRequestId: 'schedule-p2034-test-0001',
    participants: [{ studentId: 'student-p2034-test' }],
    ...overrides,
  };
}

describe('formal lesson transaction P2034 retry', () => {
  it('reopens the complete Serializable transaction after the first three P2034 failures', async () => {
    let attempts = 0;
    const isolationLevels: unknown[] = [];
    const prisma = fakePrisma(async (callback, options) => {
      attempts += 1;
      isolationLevels.push(options);
      if (attempts < 4) throw serializationFailure();
      return callback({});
    });

    const result = await runFormalLessonTransaction({
      prisma,
      input: input(),
      createInTransaction: async () => ok({ schedule: { id: 'fresh-schedule' } as never, conflicts: [] }),
    });

    expect(result).toMatchObject({ ok: true, value: { schedule: { id: 'fresh-schedule' } } });
    expect(attempts).toBe(4);
    expect(isolationLevels).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
  });

  it('after four P2034 failures preserves the existing conflict/version boundary', async () => {
    let attempts = 0;
    const prisma = fakePrisma(async () => {
      attempts += 1;
      throw serializationFailure();
    });

    const result = await runFormalLessonTransaction({
      prisma,
      input: input(),
      createInTransaction: async () => ok({ schedule: {} as never, conflicts: [] }),
    });

    expect(attempts).toBe(4);
    expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('returns a business Result from the first transaction without retrying', async () => {
    let attempts = 0;
    const businessResult = err(validationError('业务校验失败', 'scheduledStart'));
    const prisma = fakePrisma(async (callback) => {
      attempts += 1;
      return callback({});
    });

    const result = await runFormalLessonTransaction({
      prisma,
      input: input(),
      createInTransaction: async () => businessResult,
    });

    expect(attempts).toBe(1);
    expect(result).toBe(businessResult);
  });

  it('does not retry P2002 and replays an identical request', async () => {
    let attempts = 0;
    const prisma = fakePrisma(async () => {
      attempts += 1;
      throw new Prisma.PrismaClientKnownRequestError('unique conflict', {
        code: 'P2002',
        clientVersion: '6.19.3',
      });
    }, { replay: replayRecord() });

    const result = await runFormalLessonTransaction({ prisma, input: input(), createInTransaction: async () => ok({} as never) });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: true, value: { schedule: { id: 'replayed-schedule' } } });
  });

  it('maps P2002 and final P2034 same-key different-payload attempts to VERSION_CONFLICT', async () => {
    for (const code of ['P2002', 'P2034'] as const) {
      let attempts = 0;
      const prisma = fakePrisma(async () => {
        attempts += 1;
        throw new Prisma.PrismaClientKnownRequestError('unique or serialization conflict', {
          code,
          clientVersion: '6.19.3',
        });
      }, { replay: replayRecord({ title: 'different-payload' }) });

      const result = await runFormalLessonTransaction({ prisma, input: input(), createInTransaction: async () => ok({} as never) });

      expect(attempts).toBe(code === 'P2002' ? 1 : 4);
      expect(result).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    }
  });

  it('does not retry or translate a non-Prisma exception', async () => {
    let attempts = 0;
    const failure = new Error('unexpected failure');
    const prisma = fakePrisma(async () => {
      attempts += 1;
      throw failure;
    });

    await expect(runFormalLessonTransaction({ prisma, input: input(), createInTransaction: async () => ok({} as never) }))
      .rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it('prefers same-key replay over the slot conflict after final P2034', async () => {
    let attempts = 0;
    const prisma = fakePrisma(async () => {
      attempts += 1;
      throw serializationFailure();
    }, { replay: replayRecord(), conflict: replayRecord({ id: 'slot-conflict' }) });

    const result = await runFormalLessonTransaction({ prisma, input: input(), createInTransaction: async () => ok({} as never) });

    expect(attempts).toBe(4);
    expect(result).toMatchObject({ ok: true, value: { schedule: { id: 'replayed-schedule' } } });
  });

  it('maps a missing replay with a slot conflict to VALIDATION_ERROR, otherwise VERSION_CONFLICT', async () => {
    const conflictPrisma = fakePrisma(async () => { throw serializationFailure(); }, {
      conflict: { id: 'slot-conflict' },
    });
    const conflictResult = await runFormalLessonTransaction({
      prisma: conflictPrisma,
      input: input(),
      createInTransaction: async () => ok({} as never),
    });
    expect(conflictResult).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'scheduledStart' } });

    const noConflictPrisma = fakePrisma(async () => { throw serializationFailure(); });
    const noConflictResult = await runFormalLessonTransaction({
      prisma: noConflictPrisma,
      input: input(),
      createInTransaction: async () => ok({} as never),
    });
    expect(noConflictResult).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });
});
