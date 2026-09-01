import type { CommonError, Result } from '@teacher-platform/contracts';
import type { StorageService } from '../storage/index.js';

export interface CreateFileExportServiceOptions {
  storage: StorageService;
}

export interface MarkdownSection {
  heading: string;
  content: string;
}

export interface ExportMarkdownInput {
  title: string;
  sections: MarkdownSection[];
}

export interface ExportCsvInput {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ExportPdfInput {
  html: string;
}

export interface ArchiveInput {
  filename: string;
  content: string;
  directory?: string;
}

export interface ExportContentOutput {
  content: string;
  mimeType: string;
}

export interface ArchiveOutput {
  fileRef: string;
  absolutePath: string;
}

export interface FileExportService {
  exportMarkdown(input: ExportMarkdownInput): Promise<Result<ExportContentOutput, CommonError>>;
  exportCsv(input: ExportCsvInput): Promise<Result<ExportContentOutput, CommonError>>;
  exportPdf(input: ExportPdfInput): Promise<Result<ExportContentOutput, CommonError>>;
  archive(input: ArchiveInput): Promise<Result<ArchiveOutput, CommonError>>;
}
