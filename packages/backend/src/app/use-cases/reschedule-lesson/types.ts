import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type { ScheduleData } from '../../../features/scheduling/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface RescheduleLessonCommand extends EditCommandMeta {
  scheduleId: string;
  replacement: {
    scheduledStart: string;
    scheduledEnd: string;
  };
}

export interface RescheduleLessonOwnerInput {
  teacherId: string;
  scheduleId: string;
  expectedUpdatedAt?: Date;
  replacement: {
    scheduledStart: Date;
    scheduledEnd: Date;
  };
}

export interface RescheduleLessonOwnerResult {
  beforeOriginal: ScheduleData;
  original: ScheduleData;
  replacement: ScheduleData;
  conflicts: ScheduleData[];
}

export interface RescheduleLessonResult {
  original: ScheduleData;
  replacement: ScheduleData;
  conflicts: ScheduleData[];
  changeLogIds: {
    original: string;
    replacement: string;
  };
}

export interface RescheduleLessonUseCase {
  rescheduleLesson(
    command: RescheduleLessonCommand,
  ): Promise<Result<RescheduleLessonResult, CommonError>>;
}

export interface RescheduleLessonTransactionalServices {
  scheduling: {
    rescheduleLesson(
      input: RescheduleLessonOwnerInput,
    ): Promise<Result<RescheduleLessonOwnerResult, CommonError>>;
  };
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface RescheduleLessonServices {
  transaction<T>(
    work: (
      services: RescheduleLessonTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
