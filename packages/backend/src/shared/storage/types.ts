import type { CommonError, Result } from '@teacher-platform/contracts';

/**
 * StorageBackend 抽象（P11 t2：与 ops 备份线同构接口 put/get/list/delete——
 * 见 packages/ops/lib/storage-backend.mjs，p7-db-backup-design §3.1 / p10-platform-services-design §5.3）。
 * 提供时 save/read/delete 委托给 backend（S3 模式下对象入桶）；缺省 = 本地目录实现（零破坏）。
 */
export interface StorageBackend {
  /** 实现标识：'local' | 's3'（absolutePath 合成用）。 */
  kind?: string;
  /** s3 时的桶名（s3://<bucket>/<key> 合成用）。 */
  bucket?: string;
  put(key: string, content: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface CreateStorageOptions {
  rootDir: string;
  /** StorageBackend 抽象（ops 同构接口）；缺省 → 本地目录实现（现状零破坏）。 */
  backend?: StorageBackend;
}

export interface SaveFileInput {
  filename: string;
  content: Buffer | string;
  directory?: string;
  /** 精确相对 fileRef（替代 directory+filename+时间戳拼接；媒体资产用：media/<teacherId>/<assetId>/original）。 */
  exactRef?: string;
}

export interface SaveFileOutput {
  fileRef: string;
  absolutePath: string;
}

export interface ReadFileInput {
  fileRef: string;
}

export interface DeleteFileInput {
  fileRef: string;
}

export interface StorageService {
  save(input: SaveFileInput): Promise<Result<SaveFileOutput, CommonError>>;
  read(input: ReadFileInput): Promise<Result<Buffer, CommonError>>;
  delete(input: DeleteFileInput): Promise<Result<true, CommonError>>;
}
