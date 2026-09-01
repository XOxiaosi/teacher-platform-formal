import type { CommonError, Result } from '@teacher-platform/contracts';
import type { MarkdownSection } from '../../../shared/file-export/index.js';
import type { StorageService } from '../../../shared/storage/index.js';

export type AutoArchiveType = 'lesson' | 'daily-review';

export interface CreateAutoArchiveUseCaseOptions {
  storage: StorageService;
}

export interface AutoArchiveInput {
  archiveType: AutoArchiveType;
  recordId: string;
  studentName: string;
  date: Date;
  title: string;
  sections: MarkdownSection[];
}

export interface AutoArchiveResult {
  archiveType: AutoArchiveType;
  recordId: string;
  filename: string;
  fileRef: string;
  absolutePath: string;
}

export interface AutoArchiveUseCase {
  autoArchive(input: AutoArchiveInput): Promise<Result<AutoArchiveResult, CommonError>>;
}

export type AutoArchiveFactory = (options: CreateAutoArchiveUseCaseOptions) => AutoArchiveUseCase;
