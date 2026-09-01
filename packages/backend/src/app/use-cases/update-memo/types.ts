import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type {
  MemoData,
  MemoEditor,
  MemoJsonValue,
} from '../../../features/memos/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface UpdateMemoChanges {
  title?: string;
  content?: string;
  dueAt?: string | null;
  tags?: MemoJsonValue | null;
}

export interface UpdateMemoCommand extends EditCommandMeta {
  memoId: string;
  changes: UpdateMemoChanges;
}

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export type UpdateMemoResult = EditReceipt<MemoData>;

export interface UpdateMemoUseCase {
  updateMemo(command: UpdateMemoCommand): Promise<Result<UpdateMemoResult, CommonError>>;
}

export interface UpdateMemoTransactionalServices {
  memos: Pick<MemoEditor, 'updateMemo'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface UpdateMemoServices {
  transaction<T>(
    work: (
      services: UpdateMemoTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
