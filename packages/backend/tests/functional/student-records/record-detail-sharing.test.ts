import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { err, internalError } from '@teacher-platform/contracts';
import { createStudentRecordsService, createStudentSourceRecordService } from '../../../src/features/student-records/index.js';
import { createStudentRecordSourceRouter } from '../../../src/app/routes/student-record-source.routes.js';
import { createFieldCipher, encryptFieldValue, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const teacherId = 'a04-detail-a';
const otherTeacherId = 'a04-detail-b';
const records = createStudentRecordsService(prisma);
const sources = createStudentSourceRecordService(prisma);
const cipher = createFieldCipher(loadEncryptionKey().key);
async function cleanup() {
  const where = { teacherId: { in: [teacherId, otherTeacherId] } };
  await prisma.studentRecord.deleteMany({ where });
  await prisma.studentSourceRecord.deleteMany({ where });
  await prisma.student.deleteMany({ where });
  await prisma.changeLog.deleteMany({ where });
}
beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });
async function fixture(withSource = true) {
  const student = await prisma.student.create({ data: { teacherId, name: '合成甲', grade: '初一' } });
  const source = withSource ? await prisma.studentSourceRecord.create({ data: {
    teacherId, studentId: student.id, sourceType: 'manual', rawText: encryptFieldValue(cipher, '未经删改的原文'),
    captureStatus: 'captured', occurredAtTs: new Date('2026-09-01T00:00:00Z'),
  } }) : null;
  const record = await prisma.studentRecord.create({ data: {
    teacherId, studentId: student.id, sourceRecordId: source?.id, category: 'general_note',
    summary: encryptFieldValue(cipher, '正式记录全文'), reviewStatus: 'confirmed', visibility: 'internal_only',
    occurredAtTs: new Date('2026-09-01T00:00:00Z'), updatedAtTs: new Date('2026-09-01T00:00:00Z'),
  } });
  return { student, source, record };
}
function app(identity = teacherId) {
  const app = express();
  app.use((req, _res, next) => { (req as typeof req & { teacherId: string }).teacherId = identity; next(); });
  app.use(createStudentRecordSourceRouter({ records, sources }));
  return app;
}

describe('A04 record details and deliberate sharing', () => {
  it('only the authenticated owner and matching student can read decrypted original source', async () => {
    const { student, record } = await fixture();
    const url = `/students/${student.id}/records/${record.id}/source`;
    const response = await request(app()).get(url).set('x-teacher-id', otherTeacherId);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ recordId: record.id, state: 'available', source: { rawText: '未经删改的原文', captureStatus: 'captured' } });
    expect(JSON.stringify(response.body)).not.toContain('enc:v1:');
    expect((await request(app(otherTeacherId)).get(url)).status).toBe(404);
    expect((await request(app()).get(`/students/other/records/${record.id}/source`)).status).toBe(404);
  });
  it('no source and deleted source remain distinct; deleted status never exposes retained text', async () => {
    const first = await fixture(false);
    expect((await request(app()).get(`/students/${first.student.id}/records/${first.record.id}/source`)).body.data).toMatchObject({ state: 'none', source: null });
    const second = await fixture();
    await prisma.studentSourceRecord.update({ where: { id: second.source!.id }, data: { captureStatus: 'deleted' } });
    expect((await request(app()).get(`/students/${second.student.id}/records/${second.record.id}/source`)).body.data).toMatchObject({ state: 'deleted', source: { rawText: null } });
    expect(await records.getOwnedRecord({ teacherId, recordId: second.record.id })).toMatchObject({ ok: true, value: { summary: '正式记录全文' } });
  });
  it('inconsistent source owner or student cannot disclose another source', async () => {
    const { student, record, source } = await fixture();
    const url = `/students/${student.id}/records/${record.id}/source`;
    await prisma.studentSourceRecord.update({ where: { id: source!.id }, data: { teacherId: otherTeacherId } });
    expect((await request(app()).get(url)).body.data).toEqual({ recordId: record.id, state: 'unavailable', source: null });
    const other = await prisma.student.create({ data: { teacherId, name: '合成乙', grade: '初一' } });
    await prisma.studentSourceRecord.update({ where: { id: source!.id }, data: { teacherId, studentId: other.id } });
    expect((await request(app()).get(url)).body.data).toEqual({ recordId: record.id, state: 'unavailable', source: null });
  });
  it('confirmed record sharing requires displayed version; stale, unchanged and terminal changes refuse', async () => {
    const { student, record } = await fixture();
    const input = { teacherId, studentId: student.id, recordId: record.id, reviewStatus: 'confirmed' as const, visibility: 'parent_shareable' as const };
    expect(await records.reviewRecord(input)).toMatchObject({ ok: false, error: { field: 'expectedUpdatedAt' } });
    expect(await records.reviewRecord({ ...input, expectedUpdatedAt: '2020-01-01T00:00:00Z' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const changed = await records.reviewRecord({ ...input, expectedUpdatedAt: record.updatedAtTs.toISOString() });
    expect(changed).toMatchObject({ ok: true, value: { reviewStatus: 'confirmed', visibility: 'parent_shareable', summary: '正式记录全文' } });
    expect(await prisma.changeLog.count({ where: { teacherId, targetId: record.id } })).toBe(1);
    if (!changed.ok) throw Error('Expected change');
    expect(await records.reviewRecord({ ...input, expectedUpdatedAt: changed.value.updatedAt.toISOString() })).toMatchObject({ ok: false, error: { field: 'reviewStatus' } });
    await prisma.studentRecord.update({ where: { id: record.id }, data: { reviewStatus: 'superseded' } });
    expect(await records.reviewRecord({ ...input, visibility: 'internal_only', expectedUpdatedAt: changed.value.updatedAt.toISOString() })).toMatchObject({ ok: false, error: { field: 'reviewStatus' } });
  });
  it('sharing audit failure rolls back, and concurrent displayed-version changes save exactly once', async () => {
    const { student, record } = await fixture();
    const input = { teacherId, studentId: student.id, recordId: record.id, reviewStatus: 'confirmed' as const, visibility: 'parent_shareable' as const, expectedUpdatedAt: record.updatedAtTs.toISOString() };
    const failing = createStudentRecordsService({ getClient: async () => prisma, changelogFactory: () => ({ recordChange: async () => err(internalError('synthetic audit failure')) }) });
    expect(await failing.reviewRecord(input)).toMatchObject({ ok: false });
    expect(await prisma.studentRecord.findUnique({ where: { id: record.id } })).toMatchObject({ visibility: 'internal_only' });
    const outcomes = await Promise.all([records.reviewRecord(input), records.reviewRecord({ ...input, visibility: 'needs_review' })]);
    expect(outcomes.filter(result => result.ok)).toHaveLength(1);
    expect(await prisma.changeLog.count({ where: { teacherId, targetId: record.id } })).toBe(1);
  });
  it('equal-time pagination is deterministic and rejects invalid page shapes', async () => {
    const { student } = await fixture(false);
    await prisma.studentRecord.createMany({ data: Array.from({ length: 25 }, (_, i) => ({
      id: `a04-record-${String(i).padStart(2, '0')}`, teacherId, studentId: student.id, category: 'general_note', summary: `record ${i}`, occurredAtTs: new Date('2026-09-01T00:00:00Z'),
    })) });
    const pages = await Promise.all([1, 2, 3].map(page => records.listRecordsByStudent({ teacherId, studentId: student.id, page, pageSize: 10 })));
    const ids = pages.flatMap(page => page.ok ? page.value.items.map(item => item.id) : []);
    expect(ids).toHaveLength(26); expect(new Set(ids).size).toBe(26); expect(ids).toEqual([...ids].sort().reverse());
    for (const page of [0, 1.5, NaN]) expect(await records.listRecordsByStudent({ teacherId, studentId: student.id, page })).toMatchObject({ ok: false });
    expect(await records.listRecordsByStudent({ teacherId, studentId: student.id, pageSize: 101 })).toMatchObject({ ok: false });
  });
  it('same-millisecond sharing changes advance the edit version and reject reuse', async () => {
    const { student, record } = await fixture();
    const frozenClockClient = new Proxy(prisma, { get(target, property) {
      if (property === '$queryRaw') return async () => [{ now: record.updatedAtTs }];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = createStudentRecordsService(frozenClockClient);
    const input = { teacherId, studentId: student.id, recordId: record.id, reviewStatus: 'confirmed' as const, visibility: 'parent_shareable' as const, expectedUpdatedAt: record.updatedAtTs.toISOString() };
    const saved = await service.reviewRecord(input);
    if (!saved.ok) throw Error(saved.error.code);
    expect(saved.value.updatedAt.getTime()).toBe(record.updatedAtTs.getTime() + 1);
    expect(await service.reviewRecord({ ...input, visibility: 'needs_review' })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    const second = await service.reviewRecord({ ...input, visibility: 'internal_only', expectedUpdatedAt: saved.value.updatedAt.toISOString() });
    if (!second.ok) throw Error(second.error.code);
    expect(second.value.updatedAt.getTime()).toBe(saved.value.updatedAt.getTime() + 1);
    expect(await prisma.changeLog.count({ where: { teacherId, targetId: record.id } })).toBe(2);
  });
});
