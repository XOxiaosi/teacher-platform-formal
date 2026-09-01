import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type {
  ParentFeedbackContentEditor,
  ParentFeedbackData,
} from '../../../features/feedback/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface UpdateParentFeedbackContentChanges {
  title?: string;
  content?: string;
}

export interface UpdateParentFeedbackContentCommand extends EditCommandMeta {
  feedbackId: string;
  changes: UpdateParentFeedbackContentChanges;
}

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export type UpdateParentFeedbackContentResult = EditReceipt<ParentFeedbackData>;

export interface UpdateParentFeedbackContentUseCase {
  updateParentFeedbackContent(
    command: UpdateParentFeedbackContentCommand,
  ): Promise<Result<UpdateParentFeedbackContentResult, CommonError>>;
}

export interface UpdateParentFeedbackContentTransactionalServices {
  feedback: Pick<ParentFeedbackContentEditor, 'updateParentFeedbackContent'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface UpdateParentFeedbackContentServices {
  transaction<T>(
    work: (
      services: UpdateParentFeedbackContentTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
