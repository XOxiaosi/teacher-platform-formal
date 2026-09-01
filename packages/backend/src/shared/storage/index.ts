import { createRequire } from 'node:module';
import { createStorage } from './storage.js';
import type { StorageBackend, StorageService } from './types.js';

export { createStorage } from './storage.js';
export type {
  CreateStorageOptions,
  DeleteFileInput,
  ReadFileInput,
  SaveFileInput,
  SaveFileOutput,
  StorageBackend,
  StorageService,
} from './types.js';

// ops 为 ESM（.mjs），backend 为 CJS——Node ≥22.12 require(esm) 同步可用（运行时已验证）；
// 类型：最小接口 + 断言（完整声明见 packages/ops/lib/storage-backend.d.mts，测试侧可直接静态 import）
interface OpsStorageModule {
  createStorageBackendFromEnv(env?: NodeJS.ProcessEnv, defaultLocalRoot?: string): StorageBackend;
}
const requireOps = createRequire(__filename);
const opsStorage = requireOps('../../../../ops/lib/storage-backend.mjs') as unknown as OpsStorageModule;

/**
 * 应用存储装配（P11 t2 对象存储落地）：按 env 选择 StorageBackend（STORAGE_BACKEND=local|s3，
 * 缺省 local 零破坏——见 packages/ops/lib/storage-backend.mjs createStorageBackendFromEnv），
 * 注入 createStorage 委托层——S3 模式下媒体原文件/导出/归档对象入桶（fileRef 即对象 key）。
 * @param env 进程 env（测试可注入）
 * @param rootDir 本地模式的存储根（缺省 .data；S3 模式仅用于 absolutePath 合成兜底）
 */
export function createAppStorage(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = '.data',
): StorageService {
  return createStorage({
    rootDir,
    backend: opsStorage.createStorageBackendFromEnv(env, rootDir),
  });
}
