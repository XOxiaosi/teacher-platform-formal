import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { LessonData, LessonStatus } from '../../../features/lessons/index.js';

export interface LessonStatusFixInput {
  lessonId: string;
  targetStatus: LessonStatus;
}

export interface LessonBalance {
  purchased: number;
  attended: number;
  remaining: number;
}

export interface LessonStatusFixOutput {
  lesson: LessonData;
  balance: LessonBalance;
}

export interface LessonStatusFixUseCase {
  fixLessonStatus(input: LessonStatusFixInput): Promise<Result<LessonStatusFixOutput, CommonError>>;
}

export type LessonStatusFixFactory = (prisma: PrismaClient) => LessonStatusFixUseCase;
