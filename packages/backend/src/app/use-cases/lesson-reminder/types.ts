import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { LessonData } from '../../../features/lessons/index.js';

export interface LessonReminderInput {
  teacherId: string;
  now: Date;
  overdueMinutes: number;
}

export interface LessonReminderOutput {
  cutoff: Date;
  updatedCount: number;
  updatedLessons: LessonData[];
}

export interface LessonReminderUseCase {
  runLessonReminder(input: LessonReminderInput): Promise<Result<LessonReminderOutput, CommonError>>;
}

export type LessonReminderFactory = (prisma: PrismaClient) => LessonReminderUseCase;
