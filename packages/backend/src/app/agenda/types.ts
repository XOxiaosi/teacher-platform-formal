import type {
  AgendaTodayDocument,
  AgendaWeekDocument,
  CommonError,
  Result,
} from '@teacher-platform/contracts';
import type { MemoData, MemoService } from '../../features/memos/types.js';
import type {
  PendingActionData,
  PendingActionService,
} from '../../features/pending-action/types.js';
import type { ScheduleData, ScheduleService } from '../../features/scheduling/types.js';
import type { StudentData, StudentService } from '../../features/students/types.js';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';

export interface AgendaQueryDependencies {
  schedules: Pick<ScheduleService, 'listOverlappingSchedules'>;
  memos: Pick<MemoService, 'listAgendaMemos'>;
  pendingActions: Pick<PendingActionService, 'listActivePendingActions'>;
  students: Pick<StudentService, 'listOwnedStudentsByIds'>;
  trustedClock: TrustedClock;
}

export interface AgendaQueryPort {
  getToday(input: {
    teacherId: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaTodayDocument, CommonError>>;
  getWeek(input: {
    teacherId: string;
    weekStart?: string;
    timeZone: 'Asia/Shanghai';
  }): Promise<Result<AgendaWeekDocument, CommonError>>;
}

export interface AgendaProjectionSources {
  generatedAt: Date;
  timeZone: 'Asia/Shanghai';
  schedules: readonly ScheduleData[];
  memos: readonly MemoData[];
  pendingActions: readonly PendingActionData[];
  students: readonly StudentData[];
}

export interface ProjectAgendaTodayInput extends AgendaProjectionSources {
  businessDate: string;
}

export interface ProjectAgendaWeekInput extends AgendaProjectionSources {
  weekStart: string;
  weekEndExclusive: string;
  days: readonly string[];
}
