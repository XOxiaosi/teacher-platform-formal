import type {
  CommonError,
  EditCommandMeta,
  Result,
} from '@teacher-platform/contracts';
import type {
  StudentData,
  StudentProfileChanges,
  StudentProfileEditor,
} from '../../../features/students/types.js';
import type { ChangelogService } from '../../../shared/changelog/index.js';

export interface UpdateStudentProfileCommand extends EditCommandMeta {
  studentId: string;
  changes: StudentProfileChanges;
}

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export type UpdateStudentProfileResult = EditReceipt<StudentData>;

export interface UpdateStudentProfileUseCase {
  updateStudentProfile(
    command: UpdateStudentProfileCommand,
  ): Promise<Result<UpdateStudentProfileResult, CommonError>>;
}

export interface UpdateStudentProfileTransactionalServices {
  students: Pick<StudentProfileEditor, 'updateStudentProfile'>;
  changelog: Pick<ChangelogService, 'recordChange'>;
}

export interface UpdateStudentProfileServices {
  transaction<T>(
    work: (
      services: UpdateStudentProfileTransactionalServices,
    ) => Promise<Result<T, CommonError>>,
  ): Promise<Result<T, CommonError>>;
}
