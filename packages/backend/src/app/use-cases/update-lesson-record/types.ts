import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type {
  LessonData,
  LessonRecordChanges,
  LessonRecordEditor,
} from '../../../features/lessons/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface UpdateLessonRecordCommand extends EditCommandMeta {
  lessonId: string;
  changes: LessonRecordChanges;
}

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export type UpdateLessonRecordResult = EditReceipt<LessonData>;

export interface UpdateLessonRecordUseCase {
  updateLessonRecord(
    command: UpdateLessonRecordCommand,
  ): Promise<Result<UpdateLessonRecordResult, CommonError>>;
}

export interface UpdateLessonRecordTransactionalServices {
  lessons: Pick<LessonRecordEditor, 'updateLessonRecord'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface UpdateLessonRecordServices {
  transaction<T>(
    work: (
      services: UpdateLessonRecordTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
