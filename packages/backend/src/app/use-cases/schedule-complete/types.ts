import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ChangelogService } from '../../../shared/changelog/index.js';
import type { LessonData, LessonStatus } from '../../../features/lessons/index.js';
import type { ScheduleData } from '../../../features/scheduling/index.js';
import type { LessonService } from '../../../features/lessons/index.js';
import type { ScheduleService } from '../../../features/scheduling/index.js';

export type ScheduleCompletePrismaClient = PrismaClient | Prisma.TransactionClient;

export interface ScheduleCompleteInput {
  teacherId: string;
  scheduleId: string;
  lessonStatus?: LessonStatus;
}

export interface ScheduleCompleteOutput {
  schedule: ScheduleData;
  lesson: LessonData;
}

export interface ScheduleCompleteUseCase {
  completeSchedule(input: ScheduleCompleteInput): Promise<Result<ScheduleCompleteOutput, CommonError>>;
}

export interface ScheduleCompleteTransactionalServices {
  scheduling: Pick<ScheduleService, 'getSchedule' | 'updateScheduleStatus'>;
  lessons: Pick<LessonService, 'createLesson'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface ScheduleCompleteServices {
  transaction<T>(
    fn: (services: ScheduleCompleteTransactionalServices) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}

export type ScheduleCompleteFactory = (prisma: PrismaClient) => ScheduleCompleteUseCase;
