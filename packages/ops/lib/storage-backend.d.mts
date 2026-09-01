/**
 * storage-backend.mjs 类型声明（P11 t2：backend TS 侧跨包导入 ops StorageBackend 抽象）。
 * 与 packages/ops/lib/storage-backend.mjs 实现一一对应。
 */

export interface StorageBackend {
  /** 实现标识：'local' | 's3'（供上层合成 absolutePath 等）。 */
  kind?: string;
  /** s3 时的桶名（s3://<bucket>/<key> 合成用）。 */
  bucket?: string;
  put(key: string, content: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface S3StorageOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
  /** 签名时间（协议墙钟；测试可注入固定时间）。 */
  now?: () => Date;
}

export interface StorageBackendConfig {
  backend: 'local' | 's3';
  rootDir?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  forcePathStyle?: boolean;
  now?: () => Date;
}

export function assertStorageKey(key: string): void;
export function createLocalDirStorage(rootDir: string): StorageBackend;
export function createS3Storage(options: S3StorageOptions): StorageBackend;
export function createStorageBackend(config: StorageBackendConfig): StorageBackend;
export function createStorageBackendFromEnv(
  env?: NodeJS.ProcessEnv,
  defaultLocalRoot?: string,
): StorageBackend;
