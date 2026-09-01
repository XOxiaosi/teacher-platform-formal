/**
 * 连接池 / 数据库路由 env 映射（裁定点 3：SCREAMING_SNAKE ↔ camelCase）。
 *
 * 设计依据：reports/architecture/p7-process-guard-design.md §2.3（env 清单）
 * 与 reports/architecture/p7-db-routing-design.md §2.1（选项名）。
 *
 * env 名 ↔ 选项名：
 *   MAX_DB_CLIENTS        ↔ maxClients          （连接池：进程内最大热连库数，默认 100）
 *   DB_IDLE_TTL_MS        ↔ idleTtlMs           （连接池：闲置回收 TTL，默认 30 分钟）
 *   DB_SWEEP_INTERVAL_MS  ↔ sweepIntervalMs     （连接池：回收巡检间隔，默认 5 分钟）
 *   DB_REGISTRY_CACHE_TTL_MS ↔ registryCacheTtlMs（database-router：databaseName 解析缓存，默认 60s）
 */
export interface DatabasePoolEnvOptions {
  maxClients: number;
  idleTtlMs: number;
  sweepIntervalMs: number;
  registryCacheTtlMs: number;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 从环境变量解析连接池/路由配置，非法值回退默认。
 * 供装配（createApp）读取，默认参数给纯默认值。
 */
export function parseDatabasePoolEnv(env: NodeJS.ProcessEnv = process.env): DatabasePoolEnvOptions {
  return {
    maxClients: readPositiveInt(env.MAX_DB_CLIENTS, 100),
    idleTtlMs: readPositiveInt(env.DB_IDLE_TTL_MS, 30 * 60 * 1000),
    sweepIntervalMs: readPositiveInt(env.DB_SWEEP_INTERVAL_MS, 5 * 60 * 1000),
    registryCacheTtlMs: readPositiveInt(env.DB_REGISTRY_CACHE_TTL_MS, 60 * 1000),
  };
}
