/**
 * admin 后台任务（兼容层，P8 隐私自助化 t29）。
 *
 * 实现已提取至 shared/background-jobs（admin-jobs 提取为 shared 并同步 admin 引用）：
 * - 本文件仅保留 admin 既有导出名（AdminJob* / createAdminJobStore）委托共享模块，
 *   jobId 前缀沿用 adminjob_（既有契约/测试断言不变）；
 * - 新代码（隐私自助化）直接使用 shared/background-jobs 的 createJobStore。
 */
import { createJobStore } from '../../shared/background-jobs/index.js';

/** admin 任务 store：jobId 前缀沿用 adminjob_（admin.routes 与既有测试断言不变）。 */
export function createAdminJobStore(): ReturnType<typeof createJobStore> {
  return createJobStore({ jobIdPrefix: 'adminjob_' });
}

export {
  runSpawnJob,
  type BackgroundJob as AdminJob,
  type BackgroundJobKind as AdminJobKind,
  type BackgroundJobStatus as AdminJobStatus,
  type BackgroundJobStore as AdminJobStore,
  type SpawnJobOptions,
} from '../../shared/background-jobs/index.js';
