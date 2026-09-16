import { expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createFeedbackService } from '../../../src/features/feedback/feedback-service.js';
import type { ParentFeedbackData } from '../../../src/features/feedback/types.js';
import type { TrustedClock } from '../../../src/shared/trusted-clock/index.js';
import { createFieldCipher, encryptFieldValue, loadEncryptionKey } from '../../../src/shared/field-encryption/index.js';
import type { Logger } from '../../../src/shared/logger/index.js';
import type { ModerationAdapter } from '../../../src/shared/platform-services/index.js';
// P8 phase-3 批5：测试密钥 cipher（与 setup 注入同钥）——校验 DB 密文可解密
export const cipher = createFieldCipher(loadEncryptionKey().key);


// Phase 3.3-A: 红灯测试
// feedback service 当前仍是 planned stub。
// 本测试锁定 Phase 3.3 CRUD 与状态机契约，实现将在 Phase 3.3-B 完成。

export const prisma = new PrismaClient();

export const TEACHER_A = 'test-teacher-feedback-a';

export const TEACHER_B = 'test-teacher-feedback-b';


export function createService(
  trustedClock?: TrustedClock,
  moderation?: ModerationAdapter,
  logger?: Logger,
) {
  return createFeedbackService({ prisma, trustedClock, moderation, logger });
}


export function moderationAdapter(
  provider: string,
  moderateText: ModerationAdapter['moderateText'],
): ModerationAdapter {
  return { provider, moderateText };
}


export function loggerSpy(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}


export function fixedClock(value = new Date('2031-02-03T04:05:06.789Z')): TrustedClock & { now: ReturnType<typeof vi.fn> } {
  return { now: vi.fn().mockResolvedValue(ok(value)) };
}


export async function createStatusFixture(status: 'draft' | 'reviewed' | 'sent' | 'archived', sentAt: Date | null = null) {
  const student = await createStudentFixture(TEACHER_A, `状态夹具-${status}`);
  return prisma.parentFeedback.create({
    data: {
      teacherId: TEACHER_A,
      studentId: student.id,
      title: `${status}反馈`,
      content: '状态测试内容',
      status,
      sentAtTs: sentAt,
    },
  });
}


export async function cleanup() {
  // Phase 3.3-A 红灯阶段，数据库可能尚未 db push 出 ParentFeedback 表；
  // cleanup 不应让红灯退化为 schema 环境失败。实现阶段同步数据库后该清理会真实生效。
  try {
    await prisma.feedbackEvidence.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before table is pushed
  }
  try {
    await prisma.feedbackContextSnapshot.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before table is pushed
  }
  try {
    await prisma.parentFeedback.deleteMany({
      where: { teacherId: { in: [TEACHER_A, TEACHER_B] } },
    });
  } catch {
    // ignore before ParentFeedback table is pushed to test database
  }

  await prisma.communicationDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}


export async function seedAuthoritativeEvidence(studentId: string, teacherId: string, items: any[]) {
  for (const item of items) {
    await prisma.studentRecord.create({ data: { id: item.id, teacherId, studentId,
      category: item.type === 'assessment' ? 'assessment' : item.category ?? 'general_note',
      summary: encryptFieldValue(cipher, item.summary ?? ''), occurredAtTs: new Date(item.occurredAt),
      reviewStatus: 'confirmed', visibility: 'parent_shareable',
      ...(item.type === 'assessment' ? { assessment: { create: { teacherId, examName: item.examName, subject: item.subject,
        score: item.score, fullScore: item.fullScore, previousScore: item.previousScore } } } : {}),
      ...(item.parentConcerns?.length || item.followUps?.length ? { communicationDetail: { create: { teacherId, direction: 'two_way',
        parentConcerns: item.parentConcerns ?? [], followUps: item.followUps ?? [] } } } : {}),
    } });
  }
}


export async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: {
      teacherId,
      name,
      grade: '高一',
      source: 'test',
    },
  });
}


export async function createLessonFixture(teacherId: string, studentId: string) {
  const schedule = await prisma.schedule.create({
    data: {
      teacherId,
      studentId,
      type: 'lesson',
      title: '家长反馈关联课程',
      scheduledStartTs: new Date('2026-09-01T10:00:00Z'),
      scheduledEndTs: new Date('2026-09-01T11:30:00Z'),
    },
  });

  return prisma.lesson.create({
    data: {
      teacherId,
      studentId,
      scheduleId: schedule.id,
      dateTs: new Date('2026-09-01T10:00:00Z'),
      status: 'attended',
      progress: '完成牛顿第二定律复习',
    },
  });
}


export async function createFeedbackOrThrow(input: {
  teacherId: string;
  studentId: string;
  lessonId?: string;
  title: string;
  content: string;
  channel?: string;
  parentName?: string;
}): Promise<ParentFeedbackData> {
  const result = await createService().createFeedback(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}


beforeEach(async () => {
  await cleanup();
});


afterEach(async () => {
  await cleanup();
});
