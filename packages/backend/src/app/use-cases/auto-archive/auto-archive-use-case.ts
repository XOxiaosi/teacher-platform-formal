import { err, ok, validationError } from '@teacher-platform/contracts';
import type { Result, CommonError } from '@teacher-platform/contracts';
import { createFileExportService } from '../../../shared/file-export/index.js';
import type {
  AutoArchiveInput,
  AutoArchiveType,
  AutoArchiveUseCase,
  CreateAutoArchiveUseCaseOptions,
} from './types.js';

const ARCHIVE_TYPE_LABEL: Record<AutoArchiveType, string> = {
  lesson: '课次',
  'daily-review': '回顾',
};

export function createAutoArchiveUseCase(
  options: CreateAutoArchiveUseCaseOptions,
): AutoArchiveUseCase {
  const fileExport = createFileExportService({ storage: options.storage });

  return {
    async autoArchive(input: AutoArchiveInput) {
      const valid = validateInput(input);
      if (!valid.ok) return valid;

      const exported = await fileExport.exportMarkdown({
        title: input.title.trim(),
        sections: input.sections,
      });
      if (!exported.ok) return exported;

      const filename = buildArchiveFilename(input);
      const archived = await fileExport.archive({
        filename,
        content: exported.value.content,
        directory: `archives/${input.archiveType}`,
      });
      if (!archived.ok) return archived;

      return ok({
        archiveType: input.archiveType,
        recordId: input.recordId,
        filename,
        fileRef: archived.value.fileRef,
        absolutePath: archived.value.absolutePath,
      });
    },
  };
}

function validateInput(input: AutoArchiveInput): Result<true, CommonError> {
  if (!input.recordId.trim()) return err(validationError('关联记录 ID 不能为空', 'recordId'));
  if (!input.studentName.trim()) return err(validationError('学生姓名不能为空', 'studentName'));
  if (!Number.isFinite(input.date.getTime())) return err(validationError('归档日期不合法', 'date'));
  if (!input.title.trim()) return err(validationError('归档标题不能为空', 'title'));
  if (input.sections.length === 0) return err(validationError('归档内容不能为空', 'sections'));
  return ok(true);
}

function buildArchiveFilename(input: AutoArchiveInput): string {
  return `${formatDate(input.date)}_${sanitizeFilenamePart(input.studentName)}_${ARCHIVE_TYPE_LABEL[input.archiveType]}.md`;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_');
}
