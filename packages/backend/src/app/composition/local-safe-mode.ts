export const LOCAL_SAFE_MODE_ENV = 'LOCAL_SAFE_MODE';

/** 默认开启；只有显式 boolean false 或环境变量严格等于 "false" 才关闭。 */
export function resolveLocalSafeMode(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return explicit ?? env[LOCAL_SAFE_MODE_ENV] !== 'false';
}
