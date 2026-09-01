import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ACTIONS,
  BACKEND_READY_URL,
  FRONTEND_URL,
  buildRestoreInvocation,
  classifyManagedProcesses,
  createSafeChildEnvironment,
  parseAndValidateState,
  redactSensitiveText,
  runStartSequence,
  validateControllerRequest,
} from './windows-controller-core.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const nodePath = resolve('C:/Program Files/nodejs/node.exe');
const markers = {
  backend: resolve(repoRoot, 'packages/backend/src/index.ts'),
  frontend: resolve(repoRoot, 'node_modules/vite/bin/vite.js'),
};

function validState() {
  return {
    schemaVersion: 1,
    repoRoot,
    createdAt: '2026-01-01T00:00:00.000Z',
    processes: [
      {
        kind: 'backend',
        pid: 101,
        creationDate: '20260101000000.000000+000',
        executablePath: nodePath,
        commandMarker: markers.backend,
      },
      {
        kind: 'frontend',
        pid: 102,
        creationDate: '20260101000001.000000+000',
        executablePath: nodePath,
        commandMarker: markers.frontend,
      },
    ],
  };
}

function matchingSnapshots() {
  return new Map([
    [101, {
      pid: 101,
      creationDate: '20260101000000.000000+000',
      executablePath: nodePath,
      commandLine: `\"${nodePath}\" --env-file=.env \"${markers.backend}\"`,
    }],
    [102, {
      pid: 102,
      creationDate: '20260101000001.000000+000',
      executablePath: nodePath,
      commandLine: `\"${nodePath}\" \"${markers.frontend}\" --host 127.0.0.1`,
    }],
  ]);
}

test('动作和跨动作参数严格白名单；恶意 restore 输入在执行前拒绝', () => {
  assert.deepEqual(ACTIONS, [
    'Doctor', 'Install', 'Init', 'Start', 'Stop', 'Restart', 'Status', 'Logs', 'Backup', 'RestoreDrill',
  ]);
  assert.deepEqual(validateControllerRequest({}), { action: 'Status' });
  assert.throws(() => validateControllerRequest({ action: 'Destroy' }), /SAFETY_BLOCK.*action/i);
  assert.throws(
    () => validateControllerRequest({ action: 'Start', database: 'teacher_platform' }),
    /SAFETY_BLOCK.*RestoreDrill/,
  );
  assert.throws(
    () => validateControllerRequest({
      action: 'RestoreDrill',
      database: 'teacher_platform',
      dumpName: '../teacher_platform_20260101-010101.dump',
      restoreTarget: 'teacher_platform_restore_check1',
    }),
    /SAFETY_BLOCK.*dump/i,
  );
  assert.throws(
    () => validateControllerRequest({
      action: 'RestoreDrill',
      database: 'postgres',
      dumpName: 'teacher_platform_20260101-010101.dump',
      restoreTarget: 'teacher_platform_restore_check1',
    }),
    /SAFETY_BLOCK.*database/i,
  );
  assert.throws(
    () => validateControllerRequest({
      action: 'RestoreDrill',
      database: 'teacher_platform',
      dumpName: 'teacher_platform_20260101-010101.dump',
      restoreTarget: 'teacher_platform',
    }),
    /SAFETY_BLOCK.*target/i,
  );
});

test('状态损坏、未知 schema、repoRoot 不匹配均 fail-closed 且不返回可杀 PID', () => {
  assert.throws(() => parseAndValidateState('{broken', { repoRoot, nodePath, markers }), /SAFETY_BLOCK/);
  assert.throws(
    () => parseAndValidateState({ ...validState(), schemaVersion: 2 }, { repoRoot, nodePath, markers }),
    /SAFETY_BLOCK.*schema/i,
  );
  assert.throws(
    () => parseAndValidateState({ ...validState(), repoRoot: resolve(repoRoot, 'other') }, { repoRoot, nodePath, markers }),
    /SAFETY_BLOCK.*repoRoot/i,
  );
  const tampered = validState();
  tampered.processes[0].commandMarker = 'harmless-looking-marker';
  assert.throws(
    () => parseAndValidateState(tampered, { repoRoot, nodePath, markers }),
    /SAFETY_BLOCK.*marker/i,
  );
});

test('PID/CreationDate/exe/marker 四因子精确匹配；任一冲突整体零 kill', () => {
  const state = parseAndValidateState(validState(), { repoRoot, nodePath, markers });
  const owned = classifyManagedProcesses(state.processes, matchingSnapshots(), { nodePath, markers });
  assert.equal(owned.conflicts.length, 0);
  assert.deepEqual(owned.live.map((item) => item.pid), [101, 102]);

  for (const mutate of [
    (snapshot) => { snapshot.creationDate = 'reused-pid'; },
    (snapshot) => { snapshot.executablePath = resolve('C:/other/node.exe'); },
    (snapshot) => { snapshot.commandLine = 'node unrelated.js'; },
  ]) {
    const snapshots = matchingSnapshots();
    mutate(snapshots.get(101));
    const result = classifyManagedProcesses(state.processes, snapshots, { nodePath, markers });
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.killablePids, []);
  }
});

test('死亡记录可报告 dead，不因其扩大到端口或进程名杀伤', () => {
  const state = parseAndValidateState(validState(), { repoRoot, nodePath, markers });
  const snapshots = matchingSnapshots();
  snapshots.set(101, null);
  const result = classifyManagedProcesses(state.processes, snapshots, { nodePath, markers });
  assert.deepEqual(result.dead.map((item) => item.pid), [101]);
  assert.deepEqual(result.killablePids, [102]);
});

test('Start：先端口检查再 Init；端口占用或迁移失败时零 launch', async () => {
  const events = [];
  await assert.rejects(
    () => runStartSequence({
      managedProcesses: () => [],
      portOpen: async (port) => { events.push(`port:${port}`); return port === 3000; },
      init: () => events.push('init'),
      launch: () => { events.push('launch'); return {}; },
    }),
    /SAFETY_BLOCK.*port 3000/i,
  );
  assert.deepEqual(events, ['port:3000', 'port:5173']);

  events.length = 0;
  await assert.rejects(
    () => runStartSequence({
      managedProcesses: () => [],
      portOpen: async (port) => { events.push(`port:${port}`); return false; },
      init: () => { events.push('init'); throw new Error('migration failed'); },
      launch: () => { events.push('launch'); return {}; },
    }),
    /migration failed/,
  );
  assert.deepEqual(events, ['port:3000', 'port:5173', 'init']);
});

test('Start：双 HTTP readiness 通过才成功；失败仅停止本次创建记录', async () => {
  const events = [];
  const created = [
    { kind: 'backend', pid: 201 },
    { kind: 'frontend', pid: 202 },
  ];
  await assert.rejects(
    () => runStartSequence({
      managedProcesses: () => [],
      portOpen: async (port) => { events.push(`port:${port}`); return false; },
      init: () => events.push('init'),
      launch: (kind) => { events.push(`launch:${kind}`); return created.find((item) => item.kind === kind); },
      writeState: (records) => events.push(`state:${records.length}`),
      waitForHttp: async (url) => { events.push(`ready:${url}`); return url === FRONTEND_URL; },
      stopCreated: async (records) => events.push(`stop:${records.map((item) => item.pid).join(',')}`),
    }),
    /readiness/i,
  );
  assert.ok(events.indexOf('init') < events.indexOf('launch:backend'));
  assert.ok(events.includes(`ready:${BACKEND_READY_URL}`));
  assert.ok(events.includes(`ready:${FRONTEND_URL}`));
  assert.ok(events.includes('stop:201,202'));
});

test('安全子进程环境强制 loopback/local-only，且状态/日志脱敏不暴露密钥', () => {
  const env = createSafeChildEnvironment({
    DATABASE_URL: 'postgresql://admin:db-secret@127.0.0.1/teacher_platform',
    ACTION_TOKEN_SECRET: 'action-secret-value',
    PLATFORM_SERVICES_ENABLED: 'true',
    WECHAT_ILINK_ENABLED: 'true',
    STORAGE_BACKEND: 's3',
    ARK_API_KEY: 'ambient-provider-secret',
    ENCRYPTION_KEY: 'ambient-encryption-secret',
    PATH: 'C:\\Windows\\System32',
    BACKUP_ROOT: 'C:\\private-backups',
  });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.ACTION_TOKEN_SECRET, undefined);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.equal(env.ENCRYPTION_KEY, undefined);
  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.BACKUP_ROOT, 'C:\\private-backups');
  assert.equal(env.LISTEN_HOST, '127.0.0.1');
  assert.equal(env.LOCAL_SAFE_MODE, 'true');
  assert.equal(env.PLATFORM_SERVICES_ENABLED, 'false');
  assert.equal(env.WECHAT_ILINK_ENABLED, 'false');
  assert.equal(env.STORAGE_BACKEND, 'local');

  const redacted = redactSensitiveText(
    'DATABASE_URL=postgresql://admin:db-secret@127.0.0.1/teacher_platform ACTION_TOKEN_SECRET=action-secret-value Authorization: Bearer abc.def',
  );
  assert.ok(!redacted.includes('db-secret'));
  assert.ok(!redacted.includes('action-secret-value'));
  assert.ok(!redacted.includes('abc.def'));
});

test('RestoreDrill 未实证默认保留失败现场时 SAFETY_BLOCK；安全调用永无 --force/cleanup/drop', () => {
  const request = validateControllerRequest({
    action: 'RestoreDrill',
    database: 'teacher_platform',
    dumpName: 'teacher_platform_20260101-010101.dump',
    restoreTarget: 'teacher_platform_restore_check1',
  });
  assert.throws(
    () => buildRestoreInvocation(request, { retainOnFailureVerified: false }),
    /SAFETY_BLOCK.*retain/i,
  );
  const invocation = buildRestoreInvocation(request, { retainOnFailureVerified: true });
  assert.deepEqual(invocation.args, [
    '--database', 'teacher_platform',
    '--from', 'teacher_platform_20260101-010101.dump',
    '--target', 'teacher_platform_restore_check1',
  ]);
  assert.ok(!invocation.args.some((value) => /force|cleanup|drop/i.test(value)));
});

test('PowerShell 入口是 UTF-8 BOM 薄白名单，无 shell passthrough/自动安装/破坏命令', async () => {
  const scriptPath = resolve(repoRoot, 'deploy/windows/teacher-platform.ps1');
  const bytes = await readFile(scriptPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.match(text, /ValidateSet\('Doctor'.*'RestoreDrill'\)/s);
  assert.match(text, /SetAccessRuleProtection\(\$true,\s*\$false\)/);
  assert.doesNotMatch(text, /Invoke-Expression|cmd(?:\.exe)?\s*\/c|--force|DROP\s+DATABASE|prisma\s+(?:reset|db\s+push)|winget|choco|docker|New-NetFirewallRule/i);
});

test('Init 在目标机生成全新私有配置而非复制旧 env', async () => {
  const scriptPath = resolve(repoRoot, 'deploy/windows/teacher-platform.ps1');
  const text = (await readFile(scriptPath)).toString('utf8');
  assert.match(text, /RandomNumberGenerator/);
  assert.match(text, /Read-Host[^\n]+AsSecureString/);
  assert.match(text, /LOCAL_SAFE_MODE="true"/);
  assert.match(text, /Protect-Directory\s+\$ConfigRoot/);
  assert.match(text, /Set-Content\s+-LiteralPath\s+\$tempEnvironmentPath/);
  assert.match(text, /Protect-PrivateFile\s+\$tempEnvironmentPath/);
  assert.match(text, /Move-Item\s+-LiteralPath\s+\$tempEnvironmentPath\s+-Destination\s+\$EnvironmentPath/);
  assert.doesNotMatch(text, /Set-Content\s+-LiteralPath\s+\$EnvironmentPath/);
  assert.match(text, /Get-Acl\s+-LiteralPath/);
  assert.match(text, /AreAccessRulesProtected/);
  assert.doesNotMatch(text, /Copy-Item[^\n]+\.env/i);
});

test('PowerShell 入口保持薄层，进程与恢复编排只在固定 JS controller', async () => {
  const scriptPath = resolve(repoRoot, 'deploy/windows/teacher-platform.ps1');
  const text = (await readFile(scriptPath)).toString('utf8');
  assert.ok(text.split(/\r?\n/).length <= 180, 'PowerShell entry must stay below 180 lines');
  assert.match(text, /scripts\/windows-controller\.mjs/);
  assert.doesNotMatch(text, /Stop-Process|Get-CimInstance|db-restore\.mjs|db-backup\.mjs/i);

  const controller = await readFile(resolve(repoRoot, 'scripts/windows-controller.mjs'), 'utf8');
  assert.match(controller, /buildRestoreInvocation\(request,\s*\{\s*retainOnFailureVerified:\s*true\s*\}\)/);
  assert.match(controller, /restoreScriptPath/);
  assert.match(controller, /catch\s*\([^)]*\)\s*\{[^}]*stopFreshChild\(child\)/s);
  assert.ok(controller.indexOf('stopFreshChild(child)') < controller.indexOf('child.unref()'));
  assert.doesNotMatch(controller, /--cleanup-on-failure|--force/i);
});
