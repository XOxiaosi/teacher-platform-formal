import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createLessonService } from '../../../src/features/lessons/index.js';
import { createChangelogService } from '../../../src/shared/changelog/index.js';
import { createStudentTimelineService } from '../../../src/features/student-timeline/index.js';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/index.js';
import { createFieldCipher, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';

/**
 * P8 phase-3 加密落位批4（t19）：Lesson（progress/studentState/homework/teacherNote）+ ChangeLog（before/after/diff）。
 * - setup 已注入测试 ENCRYPTION_KEY → 服务 env 构建 cipher；
 * - 加密往返 / 旧明文双读 / 篡改拒绝 / owner 不变 / 缺钥 SAFETY_BLOCK / 时间线+上下文读路径解密。
 */

const prisma = new PrismaClient();
const cipher = createFieldCipher(loadEncryptionKey().key);
const TEST_KEY = 'b'.repeat(64);

const TEACHER_A = `teacher_enc4_a_${randomBytes(4).toString('hex')}`;
const TEACHER_B = `teacher_enc4_b_${randomBytes(4).toString('hex')}`;
const STUDENT_A = `student_enc4_a_${randomBytes(4).toString('hex')}`;

let lessonService: ReturnType<typeof createLessonService>;
let changelogService: ReturnType<typeof createChangelogService>;
let timelineService: ReturnType<typeof createStudentTimelineService>;
let assembleUseCase: ReturnType<typeof createAssembleParentFeedbackContextUseCase>;

beforeAll(async () => {
  await prisma.student.create({
    data: { id: STUDENT_A, teacherId: TEACHER_A, name: '加密批4学生', grade: 'grade-1', currentStatus: 'active' },
  });
  lessonService = createLessonService(prisma);
  changelogService = createChangelogService(prisma);
  timelineService = createStudentTimelineService(prisma);
  assembleUseCase = createAssembleParentFeedbackContextUseCase({ prisma });
});

afterAll(async () => {
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.changeLog.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { id: STUDENT_A } });
  await prisma.$disconnect();
});

async function createLesson(teacherId: string) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId: STUDENT_A,
      type: 'lesson',
      title: '批4课次',
      scheduledStartTs: new Date('2026-10-01T10:00:00Z'),
      scheduledEndTs: new Date('2026-10-01T11:30:00Z'),
    },
  });
  const created = await lessonService.createLesson({
    teacherId,
    studentId: STUDENT_A,
    scheduleId: schedule.id,
    date: new Date('2026-10-01T10:00:00Z'),
    status: 'attended',
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe('批4 Lesson：S1 字段加密往返', () => {
  it('updateLesson → DB 密文，get/list 解密明文', async () => {
    const lesson = await createLesson(TEACHER_A);
    const updated = await lessonService.updateLesson({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      progress: '力学第三章',
      studentState: '课堂专注',
      homework: '完成练习1-5',
      teacherNote: '计算细节待巩固',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.progress).toBe('力学第三章');
    expect(updated.value.studentState).toBe('课堂专注');
    expect(updated.value.homework).toBe('完成练习1-5');
    expect(updated.value.teacherNote).toBe('计算细节待巩固');

    // DB 是密文
    const row = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    expect(row.progress).not.toBe('力学第三章');
    expect(row.progress!.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(row.progress!)).toBe('力学第三章');
    expect(cipher.decrypt(row.studentState!)).toBe('课堂专注');
    expect(cipher.decrypt(row.homework!)).toBe('完成练习1-5');
    expect(cipher.decrypt(row.teacherNote!)).toBe('计算细节待巩固');

    // 读路径解密
    const got = await lessonService.getOwnedLesson({ teacherId: TEACHER_A, lessonId: lesson.id });
    expect(got.ok && got.value.progress).toBe('力学第三章');
    const list = await lessonService.listLessons({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(list.ok && list.value.items[0].homework).toBe('完成练习1-5');
  });

  it('旧明文双读：prisma 直插明文 lesson → 服务读直通', async () => {
    const schedule = await prisma.schedule.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        type: 'lesson',
        title: '旧明文课次',
        scheduledStartTs: new Date('2026-10-02T10:00:00Z'),
        scheduledEndTs: new Date('2026-10-02T11:30:00Z'),
      },
    });
    const legacy = await prisma.lesson.create({
      data: {
        teacherId: TEACHER_A,
        studentId: STUDENT_A,
        scheduleId: schedule.id,
        dateTs: new Date('2026-10-02T10:00:00Z'),
        status: 'attended',
        progress: '旧明文进度',
        teacherNote: '旧明文备注',
      },
    });
    const got = await lessonService.getOwnedLesson({ teacherId: TEACHER_A, lessonId: legacy.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.progress).toBe('旧明文进度');
    expect(got.value.teacherNote).toBe('旧明文备注');
  });

  it('owner 隔离不变：跨教师读课次仍 NOT_FOUND', async () => {
    const lesson = await createLesson(TEACHER_A);
    const crossed = await lessonService.getOwnedLesson({ teacherId: TEACHER_B, lessonId: lesson.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});

describe('批4 ChangeLog：before/after/diff 加密往返', () => {
  it('recordChange → DB 密文，queryChangeLogs 解密', async () => {
    const recorded = await changelogService.recordChange({
      teacherId: TEACHER_A,
      module: 'test-batch4',
      action: 'update',
      targetType: 'Lesson',
      targetId: 'lesson-enc4-1',
      before: { progress: '旧进度', note: '旧备注' },
      after: { progress: '新进度', note: '新备注' },
      source: 'manual',
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    // 服务返回已解密
    expect(recorded.value.before).toEqual({ progress: '旧进度', note: '旧备注' });
    expect(recorded.value.after).toEqual({ progress: '新进度', note: '新备注' });
    expect(recorded.value.diff).toEqual([
      { field: 'progress', oldValue: '旧进度', newValue: '新进度' },
      { field: 'note', oldValue: '旧备注', newValue: '新备注' },
    ]);

    // DB 是密文
    const row = await prisma.changeLog.findUniqueOrThrow({ where: { id: recorded.value.id } });
    expect(typeof row.before).toBe('string');
    expect((row.before as unknown as string).startsWith('enc:v1:')).toBe(true);
    expect(cipher.decryptJson<unknown>(row.before as unknown as string)).toEqual({ progress: '旧进度', note: '旧备注' });
    expect(cipher.decryptJson<unknown>(row.diff as unknown as string)).toEqual([
      { field: 'progress', oldValue: '旧进度', newValue: '新进度' },
      { field: 'note', oldValue: '旧备注', newValue: '新备注' },
    ]);

    // 读路径解密
    const queried = await changelogService.queryChangeLogs({ teacherId: TEACHER_A, targetType: 'Lesson' });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    expect(queried.value.items[0].before).toEqual({ progress: '旧进度', note: '旧备注' });
    expect(queried.value.items[0].after).toEqual({ progress: '新进度', note: '新备注' });
  });

  it('旧明文双读：prisma 直插明文 changelog 行 → 服务读直通', async () => {
    const legacy = await prisma.changeLog.create({
      data: {
        teacherId: TEACHER_A,
        module: 'legacy',
        action: 'create',
        targetType: 'Memo',
        targetId: 'memo-1',
        before: { title: '旧标题' },
        after: { title: '新标题' },
        diff: [{ field: 'title', oldValue: '旧标题', newValue: '新标题' }],
        source: 'manual',
      },
    });
    const queried = await changelogService.queryChangeLogs({ teacherId: TEACHER_A, targetType: 'Memo' });
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const entry = queried.value.items.find((item) => item.id === legacy.id);
    expect(entry?.before).toEqual({ title: '旧标题' });
    expect(entry?.after).toEqual({ title: '新标题' });
  });
});

describe('批4 读路径解密（时间线 + 上下文组装）', () => {
  it('lesson S1 在时间线解密；反馈仅解密已确认且可分享的关联正式记录', async () => {
    const lesson = await createLesson(TEACHER_A);
    await lessonService.updateLesson({
      teacherId: TEACHER_A,
      lessonId: lesson.id,
      progress: '时间线进度',
      teacherNote: '时间线备注',
    });

    const timeline = await timelineService.getStudentTimeline({ teacherId: TEACHER_A, studentId: STUDENT_A });
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const lessonEntry = timeline.value.items.find((item) => item.type === 'lesson' && item.id === lesson.id);
    expect(lessonEntry?.summary).toBe('时间线进度');

    const record = await prisma.studentRecord.create({ data: {
      teacherId: TEACHER_A, studentId: STUDENT_A, category: 'lesson_observation',
      occurredAtTs: new Date(), summary: cipher.encrypt('可分享的正式课堂事实'),
      structuredData: cipher.encryptJson({ lessonId: lesson.id, scheduleId: lesson.scheduleId }) as unknown as Prisma.InputJsonValue,
      reviewStatus: 'confirmed', visibility: 'parent_shareable',
    } });
    expect(record.summary.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(record.summary)).toBe('可分享的正式课堂事实');
    const context = await assembleUseCase.execute({ teacherId: TEACHER_A, studentId: STUDENT_A, lessonIds: [lesson.id] });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    const evidence = context.value.evidence.find((item) => item.id === record.id);
    expect(evidence?.summary).toBe('可分享的正式课堂事实');
    expect(context.value.evidence.some(item => item.id === lesson.id || item.type === 'lesson')).toBe(false);
    expect(JSON.stringify(context.value.evidence)).not.toContain('时间线进度');
    expect(JSON.stringify(context.value.evidence)).not.toContain('时间线备注');

  });
});

describe('批4 篡改拒绝 + 缺钥 SAFETY_BLOCK', () => {
  it('DB lesson progress 密文被篡改 → 服务读 INTERNAL_ERROR（SAFETY_BLOCK）', async () => {
    const lesson = await createLesson(TEACHER_A);
    await lessonService.updateLesson({ teacherId: TEACHER_A, lessonId: lesson.id, progress: '篡改测试' });
    const row = await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } });
    const original = row.progress!;
    const parts = original.split(':');
    parts[4] = Buffer.from('tampered!').toString('base64');
    await prisma.lesson.update({ where: { id: lesson.id }, data: { progress: parts.join(':') } });

    try {
      const got = await lessonService.getOwnedLesson({ teacherId: TEACHER_A, lessonId: lesson.id });
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.error.code).toBe('INTERNAL_ERROR');
      expect(got.error.message).toContain('SAFETY_BLOCK');
    } finally {
      await prisma.lesson.update({ where: { id: lesson.id }, data: { progress: original } });
    }
  });

  it('ENCRYPTION_KEY 缺省 → updateLesson/recordChange 写路径 SAFETY_BLOCK', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const lesson = await createLesson(TEACHER_A);
      const noKeyLessons = createLessonService(prisma);
      const write = await noKeyLessons.updateLesson({
        teacherId: TEACHER_A,
        lessonId: lesson.id,
        progress: '不应落库',
      });
      expect(write.ok).toBe(false);
      if (write.ok) return;
      expect(write.error.message).toContain('SAFETY_BLOCK');

      const noKeyChangelog = createChangelogService(prisma);
      const logWrite = await noKeyChangelog.recordChange({
        teacherId: TEACHER_A,
        module: 'test',
        action: 'update',
        targetType: 'Lesson',
        targetId: 'x',
        before: { a: 1 },
        after: { a: 2 },
        source: 'manual',
      });
      expect(logWrite.ok).toBe(false);
      if (logWrite.ok) return;
      expect(logWrite.error.message).toContain('SAFETY_BLOCK');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey ?? TEST_KEY;
    }
  });
});
