import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, posix, relative } from 'node:path';
import { err, internalError, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { CreateStorageOptions, DeleteFileInput, ReadFileInput, SaveFileInput, StorageService } from './types.js';

/**
 * 创建存储服务（P8 S3 媒体线阶段一 + P11 t2 对象存储落地）。
 *
 * - 缺省（无 backend）：本地受控目录实现（现状零破坏——路径穿越防护、Date.now() 文件名前缀不变）；
 * - 提供 backend（ops StorageBackend 抽象：local 或 S3 兼容实现）：save/read/delete 委托给 backend，
 *   fileRef 即对象 key——S3 模式下媒体原文件/备份对象入桶（STORAGE_BACKEND=s3，见
 *   packages/ops/lib/storage-backend.mjs createStorageBackendFromEnv）。
 * - absolutePath：本地 backend → 本地绝对路径（与 legacy 一致）；S3 backend → s3://<bucket>/<key>。
 * - 错误归一：backend 抛 ENOENT/NoSuchKey → NOT_FOUND；SAFETY_BLOCK → VALIDATION_ERROR；其余 → INTERNAL_ERROR。
 */
export function createStorage(options: CreateStorageOptions): StorageService {
  const { backend } = options;
  return {
    async save(input: SaveFileInput) {
      const ref = buildFileRef(input);
      if (!ref.ok) return ref;
      if (backend) {
        try {
          await backend.put(ref.value, input.content);
        } catch (error) {
          return err(mapBackendError(error, '保存文件失败'));
        }
        return ok({ fileRef: ref.value, absolutePath: backendAbsolutePath(backend, options.rootDir, ref.value) });
      }
      const path = resolveInsideRoot(options.rootDir, ref.value);
      if (!path.ok) return path;

      try {
        await mkdir(dirname(path.value), { recursive: true });
        await writeFile(path.value, input.content);
        return ok({ fileRef: ref.value, absolutePath: path.value });
      } catch (error) {
        return err(internalError(`保存文件失败：${errorMessage(error)}`));
      }
    },

    async read(input: ReadFileInput) {
      if (backend) {
        try {
          return ok(await backend.get(input.fileRef));
        } catch (error) {
          return err(mapBackendError(error, '读取文件失败'));
        }
      }
      const path = resolveInsideRoot(options.rootDir, input.fileRef);
      if (!path.ok) return path;

      try {
        return ok(await readFile(path.value));
      } catch (error) {
        if (isNotFound(error)) return err(notFound('文件不存在'));
        return err(internalError(`读取文件失败：${errorMessage(error)}`));
      }
    },

    async delete(input: DeleteFileInput) {
      if (backend) {
        try {
          await backend.delete(input.fileRef);
          return ok(true);
        } catch (error) {
          return err(mapBackendError(error, '删除文件失败'));
        }
      }
      const path = resolveInsideRoot(options.rootDir, input.fileRef);
      if (!path.ok) return path;

      try {
        await rm(path.value, { force: false });
        return ok(true);
      } catch (error) {
        if (isNotFound(error)) return err(notFound('文件不存在'));
        return err(internalError(`删除文件失败：${errorMessage(error)}`));
      }
    },
  };
}

function buildFileRef(input: SaveFileInput) {
  if (input.exactRef !== undefined) {
    const normalized = posix.normalize(input.exactRef);
    if (normalized.startsWith('..') || normalized.startsWith('/')) {
      return err(validationError('精确引用不能越过存储根目录', 'exactRef'));
    }
    return ok(normalized);
  }
  if (input.filename !== basename(input.filename)) {
    return err(validationError('文件名不能包含路径', 'filename'));
  }
  const directory = input.directory ? posix.normalize(input.directory) : '';
  if (directory.startsWith('..')) {
    return err(validationError('目录不能越过存储根目录', 'directory'));
  }
  return ok(posix.normalize(posix.join(directory, `${Date.now()}-${input.filename}`)));
}

function resolveInsideRoot(rootDir: string, fileRef: string) {
  const fullPath = normalize(join(rootDir, fileRef));
  const rel = relative(rootDir, fullPath);
  if (rel.startsWith('..') || rel === '') {
    return err(validationError('文件路径非法', 'fileRef'));
  }
  return ok(fullPath);
}

/** backend 模式 absolutePath：S3 → s3://<bucket>/<key>；local → 本地绝对路径（与 legacy 一致）。 */
function backendAbsolutePath(backend: { kind?: string; bucket?: string }, rootDir: string, fileRef: string): string {
  if (backend.kind === 's3' && backend.bucket) {
    return `s3://${backend.bucket}/${fileRef}`;
  }
  return normalize(join(rootDir, fileRef));
}

/** backend 错误归一：SAFETY_BLOCK → VALIDATION_ERROR；ENOENT/NoSuchKey → NOT_FOUND；其余 → INTERNAL_ERROR。 */
function mapBackendError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message.includes('SAFETY_BLOCK')) {
    return validationError(error.message.replace(/^SAFETY_BLOCK:\s*/, ''));
  }
  if (isBackendNotFound(error)) return notFound('文件不存在');
  return internalError(`${fallbackMessage}：${errorMessage(error)}`);
}

function isBackendNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'NoSuchKey')
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
