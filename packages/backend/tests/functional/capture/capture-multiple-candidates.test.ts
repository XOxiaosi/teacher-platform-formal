import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCaptureService } from '../../../src/features/capture/index.js';
import { createFieldCipher, decryptFieldValue, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const teacherId = 'a04-multiple-teacher';
const service = createCaptureService({ prisma, cipher });
async function cleanup() {
  await prisma.studentRecord.deleteMany({ where: { teacherId } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { teacherId } });
  await prisma.captureDeletionReceipt.deleteMany({ where: { teacherId } });
  await prisma.captureCandidate.deleteMany({ where: { teacherId } });
  await prisma.captureTask.deleteMany({ where: { teacherId } });
  await prisma.captureEvent.deleteMany({ where: { teacherId } });
}
beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });
async function fixture() {
  const created = await service.createText({ teacherId, clientRequestId: 'a04-create-001', text: '甲做完作业；乙说睡得少；教师计划回访。', candidates: [{ text: '甲做完作业' }, { text: '乙自述睡得少' }, { text: '教师计划回访' }] });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const student = await prisma.student.create({ data: { teacherId, name: '合成甲', grade: '初一' } });
  return { capture: created.value.capture, studentId: student.id };
}
describe('A04 one source multiple independent candidates', () => {
  it('manual candidate inputs are explicit, persisted, encrypted, and replay compares original inputs after edit', async () => {
    const { capture } = await fixture();
    expect(capture.task.processorVersion).toBe('manual-candidates-v1');
    expect(capture.candidate.id).toBe(capture.candidates[0].id);
    const identity = { teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1 };
    const edited = await service.editCandidate({ ...identity, text: '甲已经完成作业' });
    expect(edited).toMatchObject({ ok: true, value: { rawText: capture.rawText, candidates: [{ payload: { text: '甲已经完成作业' }, originalPayload: { text: '甲做完作业' }, version: 2 }, {}, {}] } });
    const replay = await service.createText({ teacherId, clientRequestId: 'a04-create-001', text: capture.rawText, candidates: [{ text: '甲做完作业' }, { text: '乙自述睡得少' }, { text: '教师计划回访' }] });
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, capture: { id: capture.id } } });
    expect(await service.createText({ teacherId, clientRequestId: 'a04-create-001', text: capture.rawText, candidates: [{ text: '改过候选' }] })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const rows = await prisma.captureCandidate.findMany({ where: { eventId: capture.id } });
    expect(JSON.stringify(rows)).not.toContain('甲已经');
    expect(JSON.stringify(rows)).not.toContain('甲做完');
  });
  it('edit reject defer and restore affect only chosen candidates, stale versions and rejected confirm fail', async () => {
    const { capture, studentId } = await fixture();
    const identity = (index: number) => ({ teacherId, eventId: capture.id, candidateId: capture.candidates[index].id, version: 1 });
    await service.editCandidate({ ...identity(0), text: '甲完成作业，尚待批改' });
    await service.reviewCandidate({ ...identity(1), action: 'reject' });
    await service.reviewCandidate({ ...identity(2), action: 'defer' });
    const restored = await createCaptureService({ prisma, cipher }).get({ teacherId, eventId: capture.id });
    expect(restored).toMatchObject({ ok: true, value: { candidates: [{ reviewStatus: 'pending', version: 2 }, { reviewStatus: 'rejected', version: 2 }, { reviewStatus: 'deferred', version: 2 }] } });
    expect(await service.confirmRecord({ ...identity(0), studentId, clientRequestId: 'a04-stale-001' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.confirmRecord({ ...identity(1), version: 2, studentId, clientRequestId: 'a04-rejected-001' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.confirmRecord({ ...identity(2), version: 2, studentId, clientRequestId: 'a04-deferred-001' })).toMatchObject({ ok: true });
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(1);
  });
  it('legacy event confirmation refuses multiple candidates; concurrent item confirmation archives exactly once and replays', async () => {
    const { capture, studentId } = await fixture();
    expect(await service.confirmRecord({ teacherId, eventId: capture.id, studentId, clientRequestId: 'a04-legacy-001' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const input = { teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1, studentId, clientRequestId: 'a04-concurrent-001' };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.confirmRecord(input)));
    expect(results.every(result => result.ok)).toBe(true);
    expect(results.filter(result => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(1);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId } })).toBe(1);
    expect(await service.confirmRecord({ ...input, version: 2 })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.confirmRecord({ ...input, scheduleId: 'changed-course' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.confirmRecord({ ...input, studentId: 'other-student' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.confirmRecord({ ...input, candidateId: capture.candidates[1].id })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(1);
  });
  it('competing request IDs and concurrent edits do not create orphan formal records', async () => {
    const { capture, studentId } = await fixture();
    const input = { teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1, studentId };
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => service.confirmRecord({ ...input, clientRequestId: `a04-compete-${index}` })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(1);
    const identity = { ...input, candidateId: capture.candidates[1].id };
    const edits = await Promise.all([service.editCandidate({ ...identity, text: '一号更正' }), service.editCandidate({ ...identity, text: '二号更正' })]);
    expect(edits.filter(result => result.ok)).toHaveLength(1);
  });
  it('different students receive independent records and original-source text, then deletion invalidates every copied source', async () => {
    const { capture, studentId } = await fixture();
    const second = await prisma.student.create({ data: { teacherId, name: '合成乙', grade: '初一' } });
    await service.editCandidate({ teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1, text: '修改后的甲作业记录' });
    for (const [index, id] of [studentId, second.id].entries()) expect(await service.confirmRecord({ teacherId, eventId: capture.id, candidateId: capture.candidates[index].id, version: index === 0 ? 2 : 1, studentId: id, clientRequestId: `a04-student-${index}` })).toMatchObject({ ok: true });
    const records = await prisma.studentRecord.findMany({ where: { teacherId }, include: { sourceRecord: true } });
    expect(records).toHaveLength(2);
    expect(records.every(record => record.sourceRecord?.sourceEntityType === 'CaptureCandidate')).toBe(true);
    expect(records.every(record => decryptFieldValue(cipher, record.sourceRecord!.rawText!) === capture.rawText)).toBe(true);
    expect(records.map(record => decryptFieldValue(cipher, record.summary))).toContain('修改后的甲作业记录');
    await service.requestDeletion({ teacherId, eventId: capture.id, clientRequestId: 'a04-delete-001' });
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(2);
    expect(await prisma.studentSourceRecord.count({ where: { teacherId, captureStatus: 'deleted', rawText: null } })).toBe(2);
    const candidates = await prisma.captureCandidate.findMany({ where: { teacherId } });
    expect(candidates.every(item => item.payload === null && item.originalPayload === null)).toBe(true);
    expect(await service.confirmRecord({ teacherId, eventId: capture.id, candidateId: capture.candidates[2].id, version: 1, studentId, clientRequestId: 'a04-after-delete-001' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
  it('list is teacher scoped, paginated deterministically, and excludes deletion-requested material even when cleanup fails', async () => {
    const { capture, studentId } = await fixture();
    await service.confirmRecord({ teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1, studentId, clientRequestId: 'a04-before-failed-deletion' });
    await service.createText({ teacherId, clientRequestId: 'a04-next-001', text: '第二份' });
    const page = await service.list({ teacherId, limit: 1 });
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.value.items).toHaveLength(1); expect(page.value.nextCursor).toBeTruthy();
    const next = await service.list({ teacherId, cursor: page.value.nextCursor!, limit: 1 });
    expect(next).toMatchObject({ ok: true, value: { items: [{ id: capture.id }], nextCursor: null } });
    expect(await service.list({ teacherId: 'a04-attacker', cursor: page.value.nextCursor! })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const failing = createCaptureService({ prisma, cipher, deletionExecutor: async () => { throw new Error('synthetic'); } });
    await failing.requestDeletion({ teacherId, eventId: capture.id, clientRequestId: 'a04-fail-delete-001' });
    expect(await prisma.studentSourceRecord.findFirst({ where: { teacherId } })).toMatchObject({ captureStatus: 'deleted', rawText: null });
    expect(await service.list({ teacherId })).toMatchObject({ ok: true, value: { items: [{ id: page.value.items[0].id }] } });
  });
  it('cross-teacher and mismatched event/candidate operations are rejected without changing data', async () => {
    const { capture, studentId } = await fixture();
    const attacker = { teacherId: 'a04-attacker', eventId: capture.id, candidateId: capture.candidates[0].id, version: 1 };
    expect(await service.editCandidate({ ...attacker, text: '攻击' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.reviewCandidate({ ...attacker, action: 'reject' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.confirmRecord({ ...attacker, studentId, clientRequestId: 'a04-attack-001' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.confirmRecord({ ...attacker, teacherId, candidateId: 'other-candidate', studentId, clientRequestId: 'a04-attack-002' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(0);
  });
  it('writes use database time after obtaining the event lock', async () => {
    const { capture } = await fixture();
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { locked = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "CaptureEvent" WHERE "id" = ${capture.id} FOR UPDATE`;
      locked(); await gate;
      return tx.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
    });
    await started;
    const editing = service.editCandidate({ teacherId, eventId: capture.id, candidateId: capture.candidates[0].id, version: 1, text: '锁释放后更正' });
    await new Promise(resolve => setTimeout(resolve, 50)); release();
    const unlockedAt = (await holder)[0].now;
    expect(await editing).toMatchObject({ ok: true });
    const row = await prisma.captureCandidate.findUniqueOrThrow({ where: { id: capture.candidates[0].id } });
    expect(row.updatedAtTs.getTime()).toBeGreaterThanOrEqual(unlockedAt.getTime());
  });

  it('migrated historical confirmations keep their original record, source and request identity', async () => {
    const student = await prisma.student.create({ data: { teacherId, name: '历史学生', grade: '初一' } });
    const result = await service.createText({ teacherId, clientRequestId: 'a04-legacy-create', text: '合成历史原文' });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const input = { teacherId, eventId: result.value.capture.id, studentId: student.id, clientRequestId: 'a04-legacy-confirm' };
    const confirmed = await service.confirmRecord(input); if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
    await prisma.captureCandidate.update({ where: { id: result.value.capture.candidate.id }, data: { confirmationRevision: null, revision: 1 } });
    const restarted = createCaptureService({ prisma, cipher });
    expect(await restarted.confirmRecord(input)).toMatchObject({ ok: true, value: { ...confirmed.value, replayed: true } });
    expect(await restarted.confirmRecord({ ...input, candidateId: result.value.capture.candidate.id, version: 1 })).toMatchObject({ ok: true, value: { recordId: confirmed.value.recordId, replayed: true } });
    expect(await prisma.studentRecord.count({ where: { teacherId } })).toBe(1);
    expect(await prisma.studentSourceRecord.findFirst({ where: { teacherId } })).toMatchObject({ sourceEntityType: 'CaptureEvent', sourceEntityId: input.eventId });
  });

  it.each([true, false])('concurrent first deletion requests replay one receipt (same key: %s)', async sameKey => {
    const { capture } = await fixture(); let executions = 0;
    const deleting = createCaptureService({ prisma, cipher, deletionExecutor: async () => { executions += 1; } });
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { locked = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "CaptureEvent" WHERE "id" = ${capture.id} FOR UPDATE`;
      locked(); await gate;
    });
    await started;
    const pending = Array.from({ length: 6 }, (_, index) => deleting.requestDeletion({ teacherId, eventId: capture.id, clientRequestId: `a04-delete-race-${sameKey ? 0 : index}` }));
    await new Promise(resolve => setTimeout(resolve, 50)); release(); await holder;
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(new Set(results.flatMap(result => result.ok ? [result.value.receipt.id] : [])).size).toBe(1);
    expect(results.filter(result => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(executions).toBe(1);
  });

});
