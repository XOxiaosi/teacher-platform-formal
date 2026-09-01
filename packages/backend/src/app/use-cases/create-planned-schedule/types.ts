import type { CommonError, Result } from '@teacher-platform/contracts';
import type { CreateScheduleResult, ScheduleService } from '../../../features/scheduling/types.js';
import type { TrustedClock } from '../../../shared/trusted-clock/index.js';

export interface CreatePlannedScheduleInput {
  teacherId: string;
  studentId?: unknown;
  type: unknown;
  title: unknown;
  scheduledStart: unknown;
  scheduledEnd: unknown;
  confidence?: unknown;
  pendingFields?: unknown;
  sourceInput?: unknown;
}

export interface CreatePlannedScheduleDependencies {
  scheduling: Pick<ScheduleService, 'createSchedule'>;
  trustedClock: TrustedClock;
}

export interface CreatePlannedScheduleUseCase {
  create(input: CreatePlannedScheduleInput): Promise<Result<CreateScheduleResult, CommonError>>;
}
