import { chmodSync, existsSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** 创建并收紧仅当前用户可访问的运行目录；权限失败直接抛出，避免假安全继续运行。 */
export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

/** 收紧已有运行文件；文件不存在时保持无副作用。 */
export function hardenPrivateFile(path) {
  if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE);
}

/** 写入启动器状态前后都维持 0600（覆盖旧 0644 文件也会先收紧）。 */
export function writePrivateFile(path, content) {
  hardenPrivateFile(path);
  writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

/** 以追加模式打开私有日志，并对已有文件立即收紧为 0600。 */
export function openPrivateAppendFile(path) {
  hardenPrivateFile(path);
  const fd = openSync(path, 'a', PRIVATE_FILE_MODE);
  fchmodSync(fd, PRIVATE_FILE_MODE);
  return fd;
}

/** @typedef {'backend'|'frontend'} ProcessKind */
/** @typedef {{pid:number,startedAt:string,kind:ProcessKind,commandFragment:string}} LauncherProcessRecord */
/** @typedef {{pid:number,startedAt:string,command:string}} ProcessSnapshot */

export function isOwnedProcess(record, snapshot) {
  return Boolean(
    snapshot
    && record.pid === snapshot.pid
    && record.startedAt === snapshot.startedAt
    && snapshot.command.includes(record.commandFragment),
  );
}

export function menuAction(input) {
  return ({
    '1': 'start', '2': 'restart', '3': 'stop', '4': 'status',
    '5': 'open', '6': 'logs', '0': 'exit',
  })[input.trim()] ?? null;
}
