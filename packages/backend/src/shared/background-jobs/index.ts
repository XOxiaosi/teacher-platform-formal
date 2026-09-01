/**
 * 后台任务共享模块（P8 隐私自助化 t29；admin-jobs 提取为 shared，admin 引用同步）。
 */
export {
  createJobStore,
  runSpawnJob,
  resolveSpawnCommand,
  resolveNpmCliJs,
  type BackgroundJob,
  type BackgroundJobKind,
  type BackgroundJobStatus,
  type BackgroundJobStore,
  type CreateJobStoreOptions,
  type SpawnJobOptions,
  type ResolvedSpawnCommand,
} from './job-store.js';
