import { chmodSync, closeSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  isOwnedProcess,
  menuAction,
  openPrivateAppendFile,
  writePrivateFile,
  type LauncherProcessRecord,
  type ProcessSnapshot,
} from '../../../../scripts/launcher-core.mjs';

const record: LauncherProcessRecord = {
  pid: 1234,
  startedAt: 'Fri Jul 25 14:00:00 2026',
  kind: 'backend',
  commandFragment: 'packages/backend/src/index.ts',
};

const snapshot: ProcessSnapshot = {
  pid: 1234,
  startedAt: 'Fri Jul 25 14:00:00 2026',
  command: 'node --env-file=.env --import tsx packages/backend/src/index.ts',
};

describe('local development launcher safety', () => {
  it('PID、启动时间与命令特征全部匹配才视为启动器进程', () => {
    expect(isOwnedProcess(record, snapshot)).toBe(true);
    expect(isOwnedProcess(record, { ...snapshot, startedAt: 'Fri Jul 25 15:00:00 2026' })).toBe(false);
    expect(isOwnedProcess(record, { ...snapshot, command: 'node unrelated-server.js' })).toBe(false);
    expect(isOwnedProcess(record, { ...snapshot, pid: 9999 })).toBe(false);
  });

  it('菜单只接受固定动作，未知输入不执行命令', () => {
    expect(menuAction('1')).toBe('start');
    expect(menuAction('2')).toBe('restart');
    expect(menuAction('3')).toBe('stop');
    expect(menuAction('4')).toBe('status');
    expect(menuAction('5')).toBe('open');
    expect(menuAction('6')).toBe('logs');
    expect(menuAction('0')).toBe('exit');
    expect(menuAction('rm -rf')).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('运行目录、状态文件与日志始终收紧为 0700/0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'launcher-private-'));
    const runtime = join(root, 'runtime');
    const state = join(runtime, 'launcher-state.json');
    const log = join(runtime, 'backend.log');
    try {
      ensurePrivateDirectory(runtime);
      expect(statSync(runtime).mode & 0o777).toBe(0o700);

      writePrivateFile(state, '{}\n');
      chmodSync(state, 0o644);
      hardenPrivateFile(state);
      expect(statSync(state).mode & 0o777).toBe(0o600);

      writeFileSync(log, 'old\n', { mode: 0o644 });
      chmodSync(log, 0o644);
      const fd = openPrivateAppendFile(log);
      closeSync(fd);
      expect(statSync(log).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
