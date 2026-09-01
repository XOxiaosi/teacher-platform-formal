import { err, ok, validationError } from '@teacher-platform/contracts';
import type {
  ArchiveInput,
  CreateFileExportServiceOptions,
  ExportCsvInput,
  ExportMarkdownInput,
  ExportPdfInput,
  FileExportService,
} from './types.js';

export function createFileExportService(
  options: CreateFileExportServiceOptions,
): FileExportService {
  return {
    async exportMarkdown(input: ExportMarkdownInput) {
      if (!input.title.trim()) return err(validationError('标题不能为空', 'title'));
      const content = buildMarkdown(input);
      return ok({ content, mimeType: 'text/markdown' });
    },

    async exportCsv(input: ExportCsvInput) {
      if (input.columns.length === 0) return err(validationError('CSV 列不能为空', 'columns'));
      const content = buildCsv(input);
      return ok({ content, mimeType: 'text/csv' });
    },

    async exportPdf(_input: ExportPdfInput) {
      return err(validationError('PDF 导出暂未实现', 'pdf'));
    },

    async archive(input: ArchiveInput) {
      const saved = await options.storage.save({
        filename: input.filename,
        content: input.content,
        directory: input.directory ?? 'exports',
      });
      return saved;
    },
  };
}

function buildMarkdown(input: ExportMarkdownInput): string {
  const lines = [`# ${input.title}`, ''];
  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '', section.content, '');
  }
  return lines.join('\n');
}

function buildCsv(input: ExportCsvInput): string {
  const header = input.columns.map(escapeCsvCell).join(',');
  const rows = input.rows.map((row) => (
    input.columns.map((column) => escapeCsvCell(row[column])).join(',')
  ));
  return [header, ...rows].join('\n');
}

function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const neutralized = typeof value === 'string' && /^[=+\-@\t\r]/.test(value)
    ? `'${text}`
    : text;
  if (!/[",\r\n]/.test(neutralized)) return neutralized;
  return `"${neutralized.replaceAll('"', '""')}"`;
}
