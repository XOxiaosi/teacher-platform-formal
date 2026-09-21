import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCaptureService } from '../../../src/features/capture/index.js';
import { createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import { createChangelogService } from '../../../src/shared/changelog/index.js';
import {
  createFieldCipher,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  encryptJsonFieldValue,
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

  it('确认记录显式保存分享范围，默认内部可见，幂等重放范围变化冲突', async () => {
    const student = await prisma.student.create({ data: { teacherId: TEACHERS[0], name: '分享范围学生', grade: '初一' } });
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-visibility-0001', text: '可分享的课堂反馈' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const internal = await service.confirmRecord({ teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'confirm-visibility-0001', studentId: student.id });
    expect(internal).toMatchObject({ ok: true, value: { visibility: 'internal_only', replayed: false } });
    const persisted = await prisma.studentRecord.findFirstOrThrow({ where: { teacherId: TEACHERS[0], studentId: student.id } });
    expect(persisted.visibility).toBe('internal_only');
    expect(await service.confirmRecord({ teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'confirm-visibility-0001', studentId: student.id, visibility: 'parent_shareable' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });

    const shareableCapture = await service.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-visibility-0002', text: '可供家长查看的课堂反馈' });
    expect(shareableCapture.ok).toBe(true);
    if (!shareableCapture.ok) return;
    const shareable = await service.confirmRecord({ teacherId: TEACHERS[0], eventId: shareableCapture.value.capture.id, clientRequestId: 'confirm-visibility-0002', studentId: student.id, visibility: 'parent_shareable' });
    expect(shareable).toMatchObject({ ok: true, value: { visibility: 'parent_shareable', replayed: false } });
    expect(await prisma.studentRecord.findUniqueOrThrow({ where: { id: shareable.ok ? shareable.value.recordId : '' } })).toMatchObject({ visibility: 'parent_shareable' });
  });

  it('确认后重建服务读取时恢复学生、状态、分享范围和更新时间，后续修改会反映到候选投影', async () => {
    const student = await prisma.student.create({ data: { teacherId: TEACHERS[0], name: '投影恢复学生', grade: '初二' } });
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-projection-0001', text: '投影恢复课堂记录' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const confirmed = await service.confirmRecord({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'confirm-projection-0001',
      studentId: student.id, visibility: 'parent_shareable',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    const restarted = new PrismaClient();
    try {
      const restored = await createCaptureService({ prisma: restarted, cipher }).get({ teacherId: TEACHERS[0], eventId: created.value.capture.id });
      expect(restored).toMatchObject({ ok: true, value: { candidate: {
        confirmedRecordId: confirmed.value.recordId,
        confirmedRecord: { id: confirmed.value.recordId, studentId: student.id, reviewStatus: 'confirmed', visibility: 'parent_shareable' },
      } } });
      const before = restored.ok ? restored.value.candidate.confirmedRecord?.updatedAt : undefined;
      const updated = await prisma.studentRecord.update({ where: { id: confirmed.value.recordId }, data: { visibility: 'internal_only', reviewStatus: 'superseded' } });
      const listed = await createCaptureService({ prisma: restarted, cipher }).list({ teacherId: TEACHERS[0] });
      expect(listed).toMatchObject({ ok: true, value: { items: [{ candidate: { confirmedRecord: {
        id: confirmed.value.recordId, studentId: student.id, reviewStatus: 'superseded', visibility: 'internal_only',
      } } }] } });
      if (listed.ok) expect(listed.value.items[0]?.candidate.confirmedRecord?.updatedAt.getTime()).toBe(updated.updatedAtTs.getTime());
      expect(before).toBeInstanceOf(Date);
    } finally {
      await restarted.$disconnect();
    }
  });

  it('历史单候选记录缺少 captureCandidateId 时仍可按事件恢复投影', async () => {
    const student = await prisma.student.create({ data: { teacherId: TEACHERS[0], name: '历史投影学生', grade: '初一' } });
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-projection-legacy-0001', text: '历史单候选投影' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const confirmed = await service.confirmRecord({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, clientRequestId: 'confirm-projection-legacy-0001',
      studentId: student.id, visibility: 'parent_shareable',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    await prisma.studentRecord.update({
      where: { id: confirmed.value.recordId },
      data: { structuredData: encryptJsonFieldValue(cipher, { captureEventId: created.value.capture.id }) as Prisma.InputJsonValue },
    });

    expect(await service.get({ teacherId: TEACHERS[0], eventId: created.value.capture.id })).toMatchObject({
      ok: true,
      value: { candidate: { confirmedRecord: {
        id: confirmed.value.recordId, studentId: student.id, reviewStatus: 'confirmed', visibility: 'parent_shareable',
      } } },
    });
  });

  it('多候选事件缺少 captureCandidateId 时不套用单候选兼容', async () => {
    const student = await prisma.student.create({ data: { teacherId: TEACHERS[0], name: '多候选投影学生', grade: '初一' } });
    const service = createCaptureService({ prisma, cipher });
    const created = await service.createText({
      teacherId: TEACHERS[0], clientRequestId: 'capture-projection-multi-0001', text: '多候选投影',
      candidates: [{ text: '候选一' }, { text: '候选二' }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const firstCandidate = created.value.capture.candidates[0];
    expect(firstCandidate).toBeDefined();
    if (!firstCandidate) return;
    const confirmed = await service.confirmRecord({
      teacherId: TEACHERS[0], eventId: created.value.capture.id, candidateId: firstCandidate.id,
      version: firstCandidate.version, clientRequestId: 'confirm-projection-multi-0001', studentId: student.id,
      visibility: 'parent_shareable',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    await prisma.studentRecord.update({
      where: { id: confirmed.value.recordId },
      data: { structuredData: encryptJsonFieldValue(cipher, { captureEventId: created.value.capture.id }) as Prisma.InputJsonValue },
    });
    await prisma.captureCandidate.updateMany({
      where: { eventId: created.value.capture.id },
      data: { confirmedRecordId: confirmed.value.recordId },
    });

    const restored = await service.get({ teacherId: TEACHERS[0], eventId: created.value.capture.id });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.candidates).toHaveLength(2);
    expect(restored.value.candidates.every(candidate => candidate.confirmedRecord === null)).toBe(true);
  });

  it('未确认、丢失和跨教师损坏的 confirmedRecord 引用安全返回 null，且创建审计包含学生与分享范围', async () => {
    const studentA = await prisma.student.create({ data: { teacherId: TEACHERS[0], name: '投影安全学生 A', grade: '初一' } });
    const studentB = await prisma.student.create({ data: { teacherId: TEACHERS[1], name: '投影安全学生 B', grade: '初一' } });
    const serviceA = createCaptureService({ prisma, cipher });
    const serviceB = createCaptureService({ prisma, cipher });
    const pending = await serviceA.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-projection-0002', text: '尚未确认' });
    expect(pending).toMatchObject({ ok: true, value: { capture: { candidate: { confirmedRecord: null } } } });

    const otherCapture = await serviceB.createText({ teacherId: TEACHERS[1], clientRequestId: 'capture-projection-0003', text: '另一教师记录' });
    expect(otherCapture.ok).toBe(true);
    if (!otherCapture.ok || !pending.ok) return;
    const otherConfirmed = await serviceB.confirmRecord({ teacherId: TEACHERS[1], eventId: otherCapture.value.capture.id, clientRequestId: 'confirm-projection-0002', studentId: studentB.id });
    expect(otherConfirmed.ok).toBe(true);
    if (!otherConfirmed.ok) return;
    const candidateId = pending.value.capture.candidate.id;
    await prisma.captureCandidate.update({ where: { id: candidateId }, data: { confirmedRecordId: otherConfirmed.value.recordId } });
    expect(await serviceA.get({ teacherId: TEACHERS[0], eventId: pending.value.capture.id })).toMatchObject({ ok: true, value: { candidate: { confirmedRecordId: otherConfirmed.value.recordId, confirmedRecord: null } } });
    await prisma.captureCandidate.update({ where: { id: candidateId }, data: { confirmedRecordId: 'missing-record-reference' } });
    expect(await serviceA.get({ teacherId: TEACHERS[0], eventId: pending.value.capture.id })).toMatchObject({ ok: true, value: { candidate: { confirmedRecord: null } } });

    const own = await serviceA.createText({ teacherId: TEACHERS[0], clientRequestId: 'capture-projection-0004', text: '需要审计的记录' });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const confirmed = await serviceA.confirmRecord({ teacherId: TEACHERS[0], eventId: own.value.capture.id, clientRequestId: 'confirm-projection-0003', studentId: studentA.id, visibility: 'parent_shareable' });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    await prisma.captureCandidate.update({ where: { id: candidateId }, data: { confirmedRecordId: confirmed.value.recordId } });
    expect(await serviceA.get({ teacherId: TEACHERS[0], eventId: pending.value.capture.id })).toMatchObject({
      ok: true,
      value: { candidate: { confirmedRecordId: confirmed.value.recordId, confirmedRecord: null } },
    });
    const audit = await createChangelogService(prisma, cipher).queryChangeLogs({
      teacherId: TEACHERS[0], targetType: 'StudentRecord', targetId: confirmed.value.recordId, action: 'create',
    });
    expect(audit.ok).toBe(true);
    if (!audit.ok) return;
    expect(audit.value.items).toHaveLength(1);
    expect(audit.value.items[0]?.after).toMatchObject({ studentId: studentA.id, visibility: 'parent_shareable' });
    expect(audit.value.items[0]?.diff).toEqual(expect.arrayContaining([
      { field: 'studentId', oldValue: null, newValue: studentA.id },
      { field: 'visibility', oldValue: null, newValue: 'parent_shareable' },
    ]));
    await prisma.$executeRaw`UPDATE "StudentRecord" SET "visibility" = ${'invalid_projection_visibility'} WHERE "id" = ${confirmed.value.recordId}`;
    expect(await serviceA.get({ teacherId: TEACHERS[0], eventId: own.value.capture.id })).toMatchObject({
      ok: true,
      value: { candidate: { confirmedRecordId: confirmed.value.recordId, confirmedRecord: null } },
    });
    await prisma.$executeRaw`UPDATE "StudentRecord" SET "visibility" = ${'parent_shareable'}, "reviewStatus" = ${'invalid_projection_review_status'} WHERE "id" = ${confirmed.value.recordId}`;
    expect(await serviceA.get({ teacherId: TEACHERS[0], eventId: own.value.capture.id })).toMatchObject({
      ok: true,
      value: { candidate: { confirmedRecordId: confirmed.value.recordId, confirmedRecord: null } },
    });
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
  await prisma.changeLog.deleteMany({ where: { teacherId } });
  await prisma.studentRecord.deleteMany({ where: { teacherId } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
  await prisma.captureDeletionReceipt.deleteMany({ where: { teacherId } });
  await prisma.captureCandidate.deleteMany({ where: { teacherId } });
  await prisma.captureTask.deleteMany({ where: { teacherId } });
  await prisma.captureEvent.deleteMany({ where: { teacherId } });
}
