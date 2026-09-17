import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHmac } from 'node:crypto';

const reserved = new Set([3000, 3001, 5173, 5432, 55432]);
const within = (parent, child) => { const part = relative(parent, child); return !part || (!part.startsWith('..') && !isAbsolute(part)); };
function port(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('端口必须为整数。');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1024 || number > 65535 || reserved.has(number)) throw new Error('拒绝不安全或保留端口。');
  return number;
}
function existingAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${label}必须为已存在的绝对路径。`);
  return realpathSync(path);
}

/** No credential contents, database connection or directory mutation occurs here. */
export function validateRealDshLocalOptions(input, projectRoot) {
  const root = existingAbsolute(projectRoot, '项目');
  const runtimeRoot = existingAbsolute(input.runtimeRoot, 'DSH 目录');
  const apiKeyFile = existingAbsolute(input.apiKeyFile, '凭据文件');
  if (!lstatSync(runtimeRoot).isDirectory() || !lstatSync(apiKeyFile).isFile()) throw new Error('DSH 目录或凭据文件类型无效。');
  if (within(root, runtimeRoot) || within(root, apiKeyFile) || within(runtimeRoot, apiKeyFile)) throw new Error('DSH 和凭据必须位于源码树外，凭据不能存入 DSH 目录。');
  if (typeof input.directory !== 'string' || !isAbsolute(input.directory)) throw new Error('请指定全新、源码树外的绝对数据目录。');
  const requested = resolve(input.directory);
  // Require the parent to exist, resolving symlink ancestors before checking.
  const directory = join(realpathSync(dirname(requested)), basename(requested));
  if (directory.length < 20 || existsSync(directory) || within(root, directory) || within(runtimeRoot, directory)
    || within(directory, root) || within(directory, runtimeRoot) || within(directory, apiKeyFile)) throw new Error('拒绝复用已有目录或不安全的数据路径。');
  const serverPort = port(input.serverPort);
  const databasePort = port(input.databasePort);
  if (serverPort === databasePort) throw new Error('后端与数据库端口不能相同。');
  return { directory, runtimeRoot, apiKeyFile, serverPort, databasePort };
}

export function buildRealDshLocalEnvironment(config, { encryptionKey, actionSecret }, source = process.env) {
  if (!/^[a-f0-9]{64}$/.test(encryptionKey) || !/^[a-f0-9]{64}$/.test(actionSecret)) throw new Error('缺少本次合成实例密钥。');
  return {
    PATH: source.PATH, LANG: 'C', LC_ALL: 'C', NODE_ENV: 'development',
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${config.databasePort}/teacher_platform`,
    ENCRYPTION_KEY: encryptionKey, ACTION_TOKEN_SECRET: actionSecret,
    PROVIDER_KEY_ENCRYPTION_KEY: createHmac('sha256', Buffer.from(encryptionKey, 'hex')).update('teacher-platform/provider-config/v1').digest('hex'),
    LOCAL_SAFE_MODE: 'true', PLATFORM_SERVICES_ENABLED: 'false', WECHAT_ILINK_ENABLED: 'false',
    LISTEN_HOST: '127.0.0.1', PORT: String(config.serverPort), LOG_LEVEL: 'error', STORAGE_BACKEND: 'local',
    DSH_RUNTIME_ENABLED: 'true', DSH_RUNTIME_ROOT: config.runtimeRoot,
    DSH_SESSION_ROOT: join(config.directory, 'dsh-sessions'),
    DEEPSEEK_API_KEY_FILE: config.apiKeyFile,
  };
}

export function parseRealDshLocalArgs(args) {
  const [directory, ...flags] = args;
  const names = { '--runtime-root': 'runtimeRoot', '--api-key-file': 'apiKeyFile', '--port': 'serverPort', '--db-port': 'databasePort' };
  const result = { directory };
  for (let index = 0; index < flags.length; index += 2) {
    const name = names[flags[index]];
    if (!name || !flags[index + 1] || Object.hasOwn(result, name)) throw new Error('未知、缺失或重复启动参数。');
    result[name] = flags[index + 1];
  }
  return result;
}
