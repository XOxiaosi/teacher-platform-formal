import { beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { err, ok, type CommonError, type Result } from '@teacher-platform/contracts';
import type { TeachingRuntimeDriver, TeachingRuntimeOutput } from '../../../src/app/teaching-runtime/runtime-driver.js';
import { createAssembleParentFeedbackContextUseCase } from '../../../src/app/use-cases/assemble-parent-feedback-context/assemble-parent-feedback-context-use-case.js';
export let createGenerateFeedbackDraftUseCase: unknown;

export let importError: unknown;

try {
  const mod = await import('../../../src/app/use-cases/generate-feedback-draft/generate-feedback-draft-use-case.js');
  createGenerateFeedbackDraftUseCase = mod.createGenerateFeedbackDraftUseCase;
} catch (e) {
  importError = e;
}


export interface GenerateFeedbackDraftUseCase {
  execute(input: {
    teacherId: string;
    studentId: string;
    lessonIds?: string[];
    tone?: 'formal' | 'warm' | 'concise';
    classSize?: '1v1' | 'small' | 'large';
    parentType?: 'normal' | 'scores' | 'sensitive';
    focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
    runtime?: { taskId: string; executionId: string; contextEpoch: number; resume?: boolean };
  }): Promise<Result<{
    studentId: string;
    lessonIds: string[];
    title: string;
    content: string;
    rationale: string;
    source: 'ai';
    evidence: Array<{
      id: string;
      type: 'assessment' | 'record' | 'lesson';
      occurredAt: string;
      category: string | null;
      summary: string | null;
      examName: string | null;
      subject: string | null;
      score: number | null;
      fullScore: number | null;
      previousScore: number | null;
    }>;
    windowStart: string;
    windowEnd: string;
    classSize?: '1v1' | 'small' | 'large';
    parentType?: 'normal' | 'scores' | 'sensitive';
    focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  }, CommonError>>;
}


export const prisma = new PrismaClient();

export const TEACHER_A = 'test-teacher-feedback-draft-a';

export const TEACHER_B = 'test-teacher-feedback-draft-b';


export function requireUseCaseFactory() {
  if (importError) {
    throw new Error(
      `generate-feedback-draft use-case import failed: ${importError instanceof Error ? importError.message : String(importError)}`,
    );
  }
  if (!createGenerateFeedbackDraftUseCase) {
    throw new Error('generate-feedback-draft use-case loaded but factory export is missing');
  }
  return createGenerateFeedbackDraftUseCase as (options: {
    prisma: PrismaClient;
    runtimeDriver: TeachingRuntimeDriver;
    context: ReturnType<typeof createAssembleParentFeedbackContextUseCase>;
  }) => GenerateFeedbackDraftUseCase;
}


export type MockFeedbackRuntimeDriver = TeachingRuntimeDriver & {
  run: ReturnType<typeof vi.fn<TeachingRuntimeDriver['run']>>;
};

export const TEST_RUNTIME_IDENTITY = {
  taskId: 'feedback-test-task',
  executionId: 'feedback-test-execution',
  contextEpoch: 0,
} as const;

export function runtimeSuccess(content: string): Result<TeachingRuntimeOutput, never> {
  return ok({
    reply: content,
    sessionRef: 'teaching-feedback-test',
    status: 'succeeded',
    checkpoint: null,
    cost: { modelCalls: 1, inputTokens: 100, outputTokens: 40, toolCalls: 0, synthetic: true },
  });
}

export function createMockRuntimeDriver(result: Result<{ content: string }, CommonError>): MockFeedbackRuntimeDriver {
  const run = vi.fn<TeachingRuntimeDriver['run']>(async () => result.ok
    ? runtimeSuccess(result.value.content)
    : err({ ...result.error, retryable: true }));
  return { availability: 'test', runtimeVersion: 'dsh-v1', run };
}


export function buildUseCase(runtimeDriver: TeachingRuntimeDriver) {
  const context = createAssembleParentFeedbackContextUseCase({ prisma });
  const useCase = requireUseCaseFactory()({ prisma, runtimeDriver, context });
  return {
    execute(input: Parameters<GenerateFeedbackDraftUseCase['execute']>[0]) {
      return useCase.execute({ ...input, runtime: input.runtime ?? TEST_RUNTIME_IDENTITY });
    },
  } satisfies GenerateFeedbackDraftUseCase;
}


export async function cleanup() {
  await prisma.assessmentDetail.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.studentRecord.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.parentFeedback.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.lesson.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.schedule.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
  await prisma.student.deleteMany({ where: { teacherId: { in: [TEACHER_A, TEACHER_B] } } });
}


export async function createStudentFixture(teacherId: string, name: string) {
  return prisma.student.create({
    data: {
      teacherId,
      name,
      grade: '高一',
      source: 'test',
      stageGoal: '提升力学综合题稳定性',
    },
  });
}


export async function createLessonFixture(input: { teacherId: string; studentId: string; progress: string; studentState?: string; homework?: string; dateTs?: Date }) {
  const dateTs = input.dateTs ?? new Date('2026-09-01T10:00:00Z');
  const schedule = await prisma.schedule.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      type: 'lesson',
      title: '反馈草稿关联课程',
      scheduledStartTs: dateTs,
      scheduledEndTs: new Date(dateTs.getTime() + 90 * 60 * 1000),
    },
  });

  const lesson = await prisma.lesson.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      scheduleId: schedule.id,
      dateTs,
      status: 'attended',
      progress: input.progress,
      studentState: input.studentState ?? null,
      homework: input.homework ?? null,
    },
  });
  // Explicitly confirmed/shareable formal record; raw Lesson fields alone are insufficient.
  await prisma.studentRecord.create({ data: { teacherId: input.teacherId, studentId: input.studentId,
    category: 'lesson_observation', summary: [input.progress, input.studentState, input.homework].filter(Boolean).join('；'),
    structuredData: { lessonId: lesson.id, scheduleId: schedule.id }, occurredAtTs: dateTs,
    reviewStatus: 'confirmed', visibility: 'parent_shareable' } });
  return lesson;
}


export async function createAssessmentRecord(opts: {
  teacherId: string;
  studentId: string;
  occurredAt: Date;
  summary: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  previousScore?: number;
}) {
  const record = await prisma.studentRecord.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      category: 'assessment',
      occurredAtTs: opts.occurredAt,
      summary: opts.summary,
      reviewStatus: 'confirmed',
      visibility: 'parent_shareable',
      importance: 'normal',
    },
  });
  if (opts.examName || opts.subject || opts.score !== undefined) {
    await prisma.assessmentDetail.create({
      data: {
        teacherId: opts.teacherId,
        studentRecordId: record.id,
        examName: opts.examName ?? null,
        subject: opts.subject ?? null,
        score: opts.score ?? null,
        fullScore: opts.fullScore ?? null,
        previousScore: opts.previousScore ?? null,
      },
    });
  }
  return record;
}


export async function createParentFeedbackFixture(opts: {
  teacherId: string;
  studentId: string;
  title: string;
  content: string;
  status?: string;
  createdAtTs?: Date;
}) {
  return prisma.parentFeedback.create({
    data: {
      teacherId: opts.teacherId,
      studentId: opts.studentId,
      title: opts.title,
      content: opts.content,
      status: opts.status ?? 'draft',
      createdAtTs: opts.createdAtTs ?? new Date(),
    },
  });
}


beforeEach(async () => {
  await cleanup();
});


afterEach(async () => {
  await cleanup();
});
