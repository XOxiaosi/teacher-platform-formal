import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCaptureService } from '../../../src/features/capture/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import {
  createFieldCipher,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  loadEncryptionKey,
} from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEACHERS = ['capture-teacher-a', 'capture-teacher-b'];

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('T-015 capture service persistence', () => {
  it('并发重放只写一组事件、任务和候选，且数据库不出现明文', async () => {
    const service = createCaptureService({ prisma, cipher });
    const requests = Array.from({ length: 8 }, () => service.createText({
      teacherId: TEACHERS[0],
      clientRequestId: 'capture-concurrent-0001',
      text: '课前做十分钟小测',
    }));

    const results = await Promise.all(requests);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(await prisma.captureEvent.count({ where: { teacherId: TEACHERS[0] } })).toBe(1);
    expect(await prisma.captureTask.count({ where: { teacherId: TEACHERS[0] } })).toBe(1);
    expect(await prisma.captureCandidate.count({ where: { teacherId: TEACHERS[0] } })).toBe(1);

    const event = await prisma.captureEvent.findFirstOrThrow({ where: { teacherId: TEACHERS[0] } });
    const candidate = await prisma.captureCandidate.findFirstOrThrow({ where: { teacherId: TEACHERS[0] } });
    expect(event.rawText).not.toContain('课前做十分钟小测');
    expect(JSON.stringify(candidate.payload)).not.toContain('课前做十分钟小测');
  });

  it('同键不同内容冲突，不同键相同内容允许成为两条教师事实', async () => {
    const service = createCaptureService({ prisma, cipher });
    const first = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-conflict-0001', text: '同一原文',
    });
    const conflict = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-conflict-0001', text: '改过的原文',
    });
    const second = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-conflict-0002', text: '同一原文',
    });

    expect(first.ok).toBe(true);
    expect(conflict).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(second.ok).toBe(true);
    expect(await prisma.captureEvent.count({ where: { teacherId: TEACHERS[0] } })).toBe(2);
  });

  it('重建 Prisma 和 service 后仍能读取同一原始事件与候选状态', async () => {
    const created = await createCaptureService({ prisma, cipher }).createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-restart-0001', text: '服务重启后仍要恢复',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const restartedPrisma = new PrismaClient();
    try {
      const restored = await createCaptureService({ prisma: restartedPrisma, cipher }).get({
        teacherId: TEACHERS[0], eventId: created.value.capture.id,
      });
      expect(restored).toMatchObject({
        ok: true,
        value: {
          rawText: '服务重启后仍要恢复',
          task: { status: 'completed' },
          candidate: { reviewStatus: 'pending', confidence: null },
        },
      });
    } finally {
      await restartedPrisma.$disconnect();
    }
  });

  it('删除失败立即隐藏业务内容，重建 service 后可重试并完成脱敏', async () => {
    const failing = createCaptureService({
      prisma,
      cipher,
      deletionExecutor: async () => { throw new Error('synthetic deletion failure'); },
    });
    const created = await failing.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-delete-0001', text: '删除后不得回弹',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const deletion = await failing.requestDeletion({
      teacherId: TEACHERS[0],
      eventId: created.value.capture.id,
      clientRequestId: 'delete-request-0001',
    });
    expect(deletion).toMatchObject({
      ok: true,
      value: { receipt: { status: 'failed', retryable: true, lastErrorCode: 'CAPTURE_DELETION_FAILED' } },
    });
    expect(await failing.get({ teacherId: TEACHERS[0], eventId: created.value.capture.id }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const restarted = createCaptureService({ prisma, cipher });
    const retried = await restarted.retryDeletion({
      teacherId: TEACHERS[0],
      receiptId: deletion.ok ? deletion.value.receipt.id : '',
    });
    expect(retried).toMatchObject({ ok: true, value: { receipt: { status: 'completed', retryable: false } } });
    const event = await prisma.captureEvent.findUniqueOrThrow({ where: { id: created.value.capture.id } });
    const candidate = await prisma.captureCandidate.findFirstOrThrow({ where: { eventId: created.value.capture.id } });
    expect(event.rawText).toBeNull();
    expect(candidate.payload).toBeNull();
  });

  it('已确认记录保留来源身份，但删除原件后来源读接口不再返回原文', async () => {
    const student = await prisma.student.create({
      data: { teacherId: TEACHERS[0], name: '来源失效测试学生', grade: '初一' },
    });
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-source-delete-0001', text: '需要删除的原始课堂记录',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const confirmed = await service.confirmRecord({
      teacherId: TEACHERS[0], eventId: created.value.capture.id,
      clientRequestId: 'confirm-source-delete-0001', studentId: student.id,
    });
    expect(confirmed).toMatchObject({ ok: true, value: { studentId: student.id } });

    const sourceBefore = await prisma.studentSourceRecord.findFirstOrThrow({
      where: { teacherId: TEACHERS[0], sourceEntityType: 'CaptureEvent', sourceEntityId: created.value.capture.id },
    });
    expect(sourceBefore.rawText).toMatch(/^enc:v1:/);

    const deleted = await service.requestDeletion({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'delete-source-0001',
    });
    expect(deleted).toMatchObject({ ok: true, value: { receipt: { status: 'completed' } } });

    const sourceAfter = await prisma.studentSourceRecord.findUniqueOrThrow({ where: { id: sourceBefore.id } });
    expect(sourceAfter).toMatchObject({ captureStatus: 'deleted', rawText: null });
    const sourceService = createStudentSourceRecordService({ getClient: async () => prisma, cipher });
    await expect(sourceService.getOwnedSource({ teacherId: TEACHERS[0], sourceRecordId: sourceBefore.id }))
      .resolves.toMatchObject({ ok: true, value: { captureStatus: 'deleted', rawText: null, id: sourceBefore.id } });

    const record = await prisma.studentRecord.findFirstOrThrow({ where: { teacherId: TEACHERS[0], sourceRecordId: sourceBefore.id } });
    expect(record.reviewStatus).toBe('confirmed');
  });

  it('删除 claim 后进程中断，租约过期时由重启服务恢复并可完成重试', async () => {
    const created = await createCaptureService({ prisma, cipher }).createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-delete-crash-0001', text: '崩溃恢复后删除',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const staleReceipt = await prisma.captureDeletionReceipt.create({
      data: {
        teacherId: TEACHERS[0],
        eventId: created.value.capture.id,
        clientRequestId: 'delete-crash-0001',
        status: 'pending',
        attemptCount: 1,
        retryable: false,
        claimToken: 'abandoned-worker-claim',
        claimExpiresAtTs: new Date(Date.now() - 60_000),
        createdAtTs: new Date(Date.now() - 120_000),
        updatedAtTs: new Date(Date.now() - 60_000),
      },
    });

    const restartedPrisma = new PrismaClient();
    try {
      const restarted = createCaptureService({ prisma: restartedPrisma, cipher });
      const recovered = await restarted.getDeletionReceipt({
        teacherId: TEACHERS[0], receiptId: staleReceipt.id,
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: { status: 'failed', retryable: true, lastErrorCode: 'CAPTURE_DELETION_INTERRUPTED' },
      });

      const retried = await restarted.retryDeletion({
        teacherId: TEACHERS[0], receiptId: staleReceipt.id,
      });
      expect(retried).toMatchObject({
        ok: true,
        value: { receipt: { status: 'completed', retryable: false, attemptCount: 2 } },
      });
      const event = await restartedPrisma.captureEvent.findUniqueOrThrow({ where: { id: created.value.capture.id } });
      expect(event.rawText).toBeNull();
    } finally {
      await restartedPrisma.$disconnect();
    }
  });

  it('并发删除重试只执行一次副作用', async () => {
    const failing = createCaptureService({
      prisma,
      cipher,
      deletionExecutor: async () => { throw new Error('first attempt fails'); },
    });
    const created = await failing.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-delete-race-0001', text: '并发重试',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = await failing.requestDeletion({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'delete-race-0001',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let executions = 0;
    const retrying = createCaptureService({
      prisma,
      cipher,
      deletionExecutor: async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => retrying.retryDeletion({
      teacherId: TEACHERS[0], receiptId: first.value.receipt.id,
    })));

    expect(executions).toBe(1);
    expect(await prisma.captureDeletionReceipt.findUniqueOrThrow({ where: { id: first.value.receipt.id } }))
      .toMatchObject({ status: 'completed', retryable: false, attemptCount: 2 });
  });

  it('同一事件使用不同删除请求编号重放时返回同一持久回执', async () => {
    const failing = createCaptureService({
      prisma,
      cipher,
      deletionExecutor: async () => { throw new Error('keep receipt retryable'); },
    });
    const created = await failing.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-delete-replay-0001', text: '只生成一张删除回执',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await failing.requestDeletion({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'delete-replay-0001',
    });
    const replay = await failing.requestDeletion({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'delete-replay-0002',
    });

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({
      ok: true,
      value: { replayed: true, receipt: { id: first.ok ? first.value.receipt.id : '' } },
    });
    expect(await prisma.captureDeletionReceipt.count({
      where: { teacherId: TEACHERS[0], eventId: created.value.capture.id },
    })).toBe(1);
  });

  it('教师不能读取、删除或重试另一位教师的事件和回执', async () => {
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-owner-0001', text: 'A 的工作信息',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await service.get({ teacherId: TEACHERS[1], eventId: created.value.capture.id }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.requestDeletion({
      teacherId: TEACHERS[1], eventId: created.value.capture.id, clientRequestId: 'delete-owner-b-0001',
    })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const deletion = await service.requestDeletion({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'delete-owner-a-0001',
    });
    expect(deletion.ok).toBe(true);
    if (!deletion.ok) return;
    expect(await service.getDeletionReceipt({ teacherId: TEACHERS[1], receiptId: deletion.value.receipt.id }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.retryDeletion({ teacherId: TEACHERS[1], receiptId: deletion.value.receipt.id }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('缺少字段加密密钥时零写入并保持明确安全阻断', async () => {
    const withoutKey = createServiceWithoutEnvironmentKey();
    await expect(withoutKey.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-no-key-0001', text: '不能明文写入',
    })).rejects.toThrow(FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE);
    expect(await prisma.captureEvent.count({ where: { teacherId: TEACHERS[0] } })).toBe(0);
  });
});

function createServiceWithoutEnvironmentKey() {
  const original = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    return createCaptureService({ prisma });
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
}

async function cleanup() {
  const teacherId = { in: TEACHERS };
  await prisma.studentRecord.deleteMany({ where: { teacherId } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
  await prisma.captureDeletionReceipt.deleteMany({ where: { teacherId } });
  await prisma.captureCandidate.deleteMany({ where: { teacherId } });
  await prisma.captureTask.deleteMany({ where: { teacherId } });
  await prisma.captureEvent.deleteMany({ where: { teacherId } });
}
