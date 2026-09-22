import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createScheduleService } from '../../src/features/scheduling/schedule-service.js';
import { createScheduleCompleteUseCase } from '../../src/app/use-cases/schedule-complete/index.js';
import { createCaptureService } from '../../src/features/capture/index.js';
import { createStudentRecordsService } from '../../src/features/student-records/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../src/shared/field-encryption/index.js';

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEACHER_A = 't016-teacher-a';
const TEACHER_B = 't016-teacher-b';

async function cleanup() {
  const teachers = [TEACHER_A, TEACHER_B];
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.studentSourceRecord.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.captureCandidate.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.captureTask.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.captureDeletionReceipt.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.captureEvent.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: teachers } } });
}

beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

describe('T-016 web vertical: formal course and confirmed record', () => {
  it('小班只以正式参与人关系排课，五字段返回明文而敏感文本加密落库', async () => {
    const [a1, a2] = await Promise.all([
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '甲', grade: 'G1' } }),
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '乙', grade: 'G1' } }),
    ]);
    const service = createScheduleService({ getClient: async () => prisma, cipher });
    const created = await service.createSchedule({
      teacherId: TEACHER_A, clientRequestId: 't016-small-group-0001', type: 'lesson',
      participantIds: [a1.id, a2.id], classFormat: 'small_group', location: '工作室 A',
      operationalNote: '课前确认小测纸', scheduledStart: new Date('2026-10-01T01:00:00.000Z'), scheduledEnd: new Date('2026-10-01T02:00:00.000Z'),
    });
    expect(created).toMatchObject({ ok: true, value: { schedule: { participantIds: [a1.id, a2.id], location: '工作室 A', classFormat: 'small_group', operationalNote: '课前确认小测纸', title: '' } } });
    const row = await prisma.schedule.findFirstOrThrow({ where: { teacherId: TEACHER_A } });
    expect(row.locationCiphertext).not.toContain('工作室 A');
    expect(row.operationalNoteCiphertext).not.toContain('课前确认小测纸');
    expect(await prisma.scheduleParticipant.count({ where: { scheduleId: row.id, teacherId: TEACHER_A } })).toBe(2);
  });

  it('拒绝跨教师参与人，并对相同排课请求幂等、不同载荷冲突', async () => {
    const [a, b] = await Promise.all([
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '甲', grade: 'G1' } }),
      prisma.student.create({ data: { teacherId: TEACHER_B, name: '乙', grade: 'G2' } }),
    ]);
    const service = createScheduleService({ getClient: async () => prisma, cipher });
    const cross = await service.createSchedule({ teacherId: TEACHER_A, clientRequestId: 't016-cross-user-0001', type: 'lesson', participantIds: [b.id], classFormat: 'one_to_one', location: '线上', scheduledStart: new Date('2026-10-02T01:00:00.000Z'), scheduledEnd: new Date('2026-10-02T02:00:00.000Z') });
    expect(cross).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const base = { teacherId: TEACHER_A, clientRequestId: 't016-idempotent-0001', type: 'lesson' as const, participantIds: [a.id], classFormat: 'one_to_one' as const, location: '线上', scheduledStart: new Date('2026-10-03T01:00:00.000Z'), scheduledEnd: new Date('2026-10-03T02:00:00.000Z') };
    const first = await service.createSchedule(base);
    const replay = await service.createSchedule(base);
    const conflict = await service.createSchedule({ ...base, location: '工作室 B' });
    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true, value: { schedule: { id: first.ok ? first.value.schedule.id : '' } } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('完课为小班每名参与人建立一条课次，重复完成不重复写入', async () => {
    const students = await Promise.all(['甲', '乙'].map((name) => prisma.student.create({ data: { teacherId: TEACHER_A, name, grade: 'G1' } })));
    const schedules = createScheduleService({ getClient: async () => prisma, cipher });
    const created = await schedules.createSchedule({ teacherId: TEACHER_A, clientRequestId: 't016-complete-group-0001', type: 'lesson', participantIds: students.map((student) => student.id), classFormat: 'small_group', location: '工作室 A', scheduledStart: new Date('2026-10-04T01:00:00.000Z'), scheduledEnd: new Date('2026-10-04T02:00:00.000Z') });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const complete = createScheduleCompleteUseCase({ getClient: async () => prisma, cipher });
    const first = await complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: created.value.schedule.id });
    const replay = await complete.completeSchedule({ teacherId: TEACHER_A, scheduleId: created.value.schedule.id });
    expect(first).toMatchObject({ ok: true, value: { lessons: [{}, {}] } });
    expect(replay).toMatchObject({ ok: true, value: { lessons: [{}, {}] } });
    expect(await prisma.lesson.count({ where: { scheduleId: created.value.schedule.id, teacherId: TEACHER_A } })).toBe(2);
  });

  it('文字候选必须显式确认后才写入单一 confirmed StudentRecord，重放与跨教师均安全', async () => {
    const [a, b] = await Promise.all([
      prisma.student.create({ data: { teacherId: TEACHER_A, name: '甲', grade: 'G1' } }),
      prisma.student.create({ data: { teacherId: TEACHER_B, name: '乙', grade: 'G2' } }),
    ]);
    const capture = createCaptureService({ prisma, cipher });
    const created = await capture.createText({ teacherId: TEACHER_A, clientRequestId: 't016-capture-create-0001', text: '下次课前安排十分钟小测' });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const cross = await capture.confirmRecord({ teacherId: TEACHER_B, eventId: created.value.capture.id, clientRequestId: 't016-capture-confirm-0001', studentId: b.id });
    expect(cross).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const first = await capture.confirmRecord({ teacherId: TEACHER_A, eventId: created.value.capture.id, clientRequestId: 't016-capture-confirm-0001', studentId: a.id });
    const replay = await capture.confirmRecord({ teacherId: TEACHER_A, eventId: created.value.capture.id, clientRequestId: 't016-capture-confirm-0001', studentId: a.id });
    expect(first).toMatchObject({ ok: true, value: { studentId: a.id, category: 'general_note', replayed: false } });
    expect(replay).toMatchObject({ ok: true, value: { studentId: a.id, replayed: true } });
    expect(await prisma.studentRecord.count({ where: { teacherId: TEACHER_A, studentId: a.id, reviewStatus: 'confirmed' } })).toBe(1);
    const row = await prisma.studentRecord.findFirstOrThrow({ where: { teacherId: TEACHER_A, studentId: a.id } });
    expect(row.summary).not.toContain('十分钟小测');
    const timeline = await createStudentRecordsService({ getClient: async () => prisma, cipher }).listRecordsByStudent({ teacherId: TEACHER_A, studentId: a.id });
    expect(timeline).toMatchObject({ ok: true, value: { items: [{ summary: '下次课前安排十分钟小测', reviewStatus: 'confirmed' }] } });
    const refreshed = await capture.get({ teacherId: TEACHER_A, eventId: created.value.capture.id });
    expect(refreshed).toMatchObject({ ok: true, value: { confirmedRecordId: row.id, candidate: { reviewStatus: 'confirmed', confirmedRecordId: row.id } } });
  });
});
