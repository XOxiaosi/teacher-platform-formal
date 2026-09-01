/**
 * 数据库安全校验库（P7 S4，T9 设计 §4.4）。
 *
 * 从 packages/contracts/scripts/verify-empty-migration.mjs（assertSafeBaseUrl /
 * assertSafeTestDatabaseName）与 packages/backend/scripts/test-database-safety.mjs
 * （assertLocalDatabaseUrl）移植并扩展，供全部 ops 工具复用。
 *
 * 红线：
 * - assertSafeBaseUrl：协议必须 postgres，host 必须本机（localhost/127.0.0.1/::1），
 *   且连接串必须带数据库名（本地开发红线；远端白名单属阶段二）。
 * - assertSafeTeacherDatabaseName：教师库名必须 teacher_db_ 前缀白名单 + ^[a-z0-9_]+$，
 *   且不得等于源库/共享库/系统库。
 * - assertSafeRestoreDatabaseName：恢复演练库名必须匹配
 *   teacher_db_*_restore_* 或 teacher_platform_restore_* 形态（t28 db-restore 用）。
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export const TEACHER_DB_PREFIX = 'teacher_db_';
export const SHARED_DB_NAME = 'teacher_platform';
export const SYSTEM_DB_NAMES = new Set(['postgres', 'template0', 'template1', SHARED_DB_NAME]);

/** 教师库名白名单形态：teacher_db_ 前缀 + 小写字母数字下划线。 */
const TEACHER_DB_NAME_PATTERN = /^[a-z0-9_]+$/;

/** 恢复演练库形态：teacher_db_<name>_restore_<rand> 或 teacher_platform_restore_<rand>。 */
const RESTORE_DB_PATTERN = /^(teacher_db_[a-z0-9_]+_restore_[a-z0-9]+|teacher_platform_restore_[a-z0-9]+)$/;

/** 校验并解析 DATABASE_URL（postgres 协议 + 本机 host + 带库名）。返回 { url, databaseName }。 */
export function assertSafeBaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('SAFETY_BLOCK: DATABASE_URL must use PostgreSQL');
  }
  // URL API 对 IPv6 hostname 会带方括号（[::1]），去掉后与本机白名单比较。
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error('SAFETY_BLOCK: ops tools only allow a local PostgreSQL host');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) throw new Error('SAFETY_BLOCK: source database name is missing');
  return { url, databaseName };
}

/**
 * 教师库名安全校验。
 * @param {string} databaseName 待校验库名
 * @param {string} sourceDatabaseName 源库名（DATABASE_URL 指向，禁止相等）
 */
export function assertSafeTeacherDatabaseName(databaseName, sourceDatabaseName) {
  if (!databaseName.startsWith(TEACHER_DB_PREFIX)) {
    throw new Error(`SAFETY_BLOCK: teacher database must start with ${TEACHER_DB_PREFIX}`);
  }
  if (!TEACHER_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error('SAFETY_BLOCK: teacher database name contains unsafe characters');
  }
  if (SYSTEM_DB_NAMES.has(databaseName)) {
    throw new Error('SAFETY_BLOCK: teacher database name collides with a reserved database');
  }
  if (databaseName === sourceDatabaseName) {
    throw new Error('SAFETY_BLOCK: teacher database must differ from source database');
  }
  return databaseName;
}

/**
 * 恢复演练库名安全校验（t28 db-restore --target）。
 * 识别 teacher_db_*_restore_* 与 teacher_platform_restore_* 形态，禁止其余任意名字
 * （防止误指向真实业务库/共享库）。
 */
export function assertSafeRestoreDatabaseName(databaseName) {
  if (!RESTORE_DB_PATTERN.test(databaseName)) {
    throw new Error(
      'SAFETY_BLOCK: restore database must match teacher_db_*_restore_* or teacher_platform_restore_*',
    );
  }
  if (!TEACHER_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error('SAFETY_BLOCK: restore database name contains unsafe characters');
  }
  if (SYSTEM_DB_NAMES.has(databaseName)) {
    throw new Error('SAFETY_BLOCK: restore database name collides with a reserved database');
  }
  return databaseName;
}

/** 判断库名是否为恢复演练库形态（供脚本分支用，不抛错）。 */
export function isRestoreDatabaseName(databaseName) {
  return RESTORE_DB_PATTERN.test(databaseName);
}
