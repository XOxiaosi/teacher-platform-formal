/**
 * formidable 3.x 本地类型声明（包未自带 types；仅声明本仓库用到的 API 面）。
 * 用法：formidable({ maxFileSize, maxFields, multiples, allowEmptyFiles }) → form.parse(req, cb)
 */

declare module 'formidable' {
  import type { IncomingMessage } from 'node:http';

  export interface FormidableFile {
    filepath: string;
    originalFilename: string | null;
    mimetype: string | null;
    size: number;
  }

  export interface FormidableOptions {
    maxFileSize?: number;
    maxTotalFileSize?: number;
    maxFields?: number;
    multiples?: boolean;
    allowEmptyFiles?: boolean;
  }

  export interface Formidable {
    parse(
      req: IncomingMessage,
      callback: (
        error: Error | null | undefined,
        fields: Record<string, string | string[]>,
        files: Record<string, FormidableFile | FormidableFile[] | undefined>,
      ) => void,
    ): void;
  }

  export function formidable(options?: FormidableOptions): Formidable;
}
