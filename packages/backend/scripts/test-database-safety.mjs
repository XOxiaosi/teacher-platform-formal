export const TEST_DATABASE_PREFIX = 'teacher_platform_test_';

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function databaseNameFromUrl(url) {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) throw new Error('SAFETY_BLOCK: DATABASE_URL 缺少数据库名');
  return name;
}

export function assertLocalDatabaseUrl(url) {
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('SAFETY_BLOCK: 测试数据库必须使用 PostgreSQL');
  }
  if (!LOCAL_DATABASE_HOSTS.has(url.hostname)) {
    throw new Error('SAFETY_BLOCK: 测试建库来源必须是本机 PostgreSQL');
  }
  databaseNameFromUrl(url);
}

export function buildTestDatabaseName(randomSuffix) {
  if (!/^[a-f0-9]{12}$/i.test(randomSuffix)) {
    throw new Error('SAFETY_BLOCK: 临时数据库随机后缀不合法');
  }
  return `${TEST_DATABASE_PREFIX}${randomSuffix.toLowerCase()}`;
}

export function assertSafeTestDatabaseName(databaseName, sourceDatabaseName) {
  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error('SAFETY_BLOCK: 临时数据库名称缺少安全前缀');
  }
  if (databaseName === sourceDatabaseName) {
    throw new Error('SAFETY_BLOCK: 禁止将来源数据库作为临时测试库');
  }
}
