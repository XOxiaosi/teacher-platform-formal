import { resolve } from 'node:path';

export const ACTIONS = Object.freeze([
  'Doctor',
  'Install',
  'Init',
  'Start',
  'Stop',
  'Restart',
  'Status',
  'Logs',
  'Backup',
  'RestoreDrill',
]);

export const STATE_SCHEMA_VERSION = 1;
export const BACKEND_READY_URL = 'http://127.0.0.1:3000/api/v1/health/ready';
export const FRONTEND_URL = 'http://127.0.0.1:5173';

const DATABASE_PATTERN = /^(teacher_platform|teacher_db_[a-z0-9_]+)$/;
const DUMP_NAME_PATTERN = /^[a-z0-9_]+_\d{8}-\d{6}\.dump$/;
const RESTORE_TARGET_PATTERN = /^(teacher_platform_restore_[a-z0-9]+|teacher_db_[a-z0-9_]+_restore_[a-z0-9]+)$/;
const PROCESS_KINDS = new Set(['backend', 'frontend']);
const RESTORE_ONLY_KEYS = ['database', 'dumpName', 'restoreTarget'];

function safetyBlock(message) {
  return new Error(`SAFETY_BLOCK: ${message}`);
}

export function validateControllerRequest(input = {}) {
  const action = input.action ?? 'Status';
  if (!ACTIONS.includes(action)) throw safetyBlock(`unknown action: ${String(action)}`);

  const suppliedRestoreKeys = RESTORE_ONLY_KEYS.filter((key) => input[key] !== undefined);
  if (action !== 'RestoreDrill' && suppliedRestoreKeys.length > 0) {
    throw safetyBlock('Database/DumpName/RestoreTarget are RestoreDrill-only parameters');
  }
  if (action !== 'RestoreDrill') return { action };

  if (suppliedRestoreKeys.length !== RESTORE_ONLY_KEYS.length) {
    throw safetyBlock('RestoreDrill requires Database, DumpName, and RestoreTarget');
  }
  if (!DATABASE_PATTERN.test(input.database)) {
    throw safetyBlock('database must be teacher_platform or a teacher_db_* name');
  }
  if (!DUMP_NAME_PATTERN.test(input.dumpName)) {
    throw safetyBlock('dump name must be a MANIFEST bare .dump name');
  }
  if (!RESTORE_TARGET_PATTERN.test(input.restoreTarget)) {
    throw safetyBlock('restore target must be a dedicated restore database name');
  }
  return {
    action,
    database: input.database,
    dumpName: input.dumpName,
    restoreTarget: input.restoreTarget,
  };
}

function sameResolvedPath(left, right) {
  return resolve(left) === resolve(right);
}

function validateProcessRecord(record, context) {
  if (!record || typeof record !== 'object' || !PROCESS_KINDS.has(record.kind)) {
    throw safetyBlock('state contains an invalid process kind');
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw safetyBlock('state contains an invalid PID');
  }
  for (const key of ['creationDate', 'executablePath', 'commandMarker']) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw safetyBlock(`state process ${key} is invalid`);
    }
  }
  if (!sameResolvedPath(record.executablePath, context.nodePath)) {
    throw safetyBlock('state executablePath is not the resolved node executable');
  }
  if (!sameResolvedPath(record.commandMarker, context.markers[record.kind])) {
    throw safetyBlock('state command marker does not match the fixed repository entry');
  }
  return { ...record };
}

export function parseAndValidateState(raw, context) {
  let state = raw;
  if (typeof raw === 'string') {
    try {
      state = JSON.parse(raw);
    } catch {
      throw safetyBlock('controller state is corrupt; the original file was preserved');
    }
  }
  if (!state || typeof state !== 'object') throw safetyBlock('controller state is invalid');
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw safetyBlock(`unknown controller state schema: ${String(state.schemaVersion)}`);
  }
  if (typeof state.repoRoot !== 'string' || !sameResolvedPath(state.repoRoot, context.repoRoot)) {
    throw safetyBlock('controller state repoRoot mismatch; the original file was preserved');
  }
  if (typeof state.createdAt !== 'string' || Number.isNaN(Date.parse(state.createdAt))) {
    throw safetyBlock('controller state createdAt is invalid');
  }
  if (!Array.isArray(state.processes) || state.processes.length > 2) {
    throw safetyBlock('controller state process list is invalid');
  }
  const processes = state.processes.map((record) => validateProcessRecord(record, context));
  if (new Set(processes.map((record) => record.kind)).size !== processes.length) {
    throw safetyBlock('controller state contains duplicate process kinds');
  }
  return { ...state, processes };
}

function processIdentityMatches(record, snapshot, context) {
  return Boolean(
    snapshot
    && snapshot.pid === record.pid
    && snapshot.creationDate === record.creationDate
    && sameResolvedPath(snapshot.executablePath, context.nodePath)
    && sameResolvedPath(record.executablePath, context.nodePath)
    && record.commandMarker === context.markers[record.kind]
    && typeof snapshot.commandLine === 'string'
    && snapshot.commandLine.includes(record.commandMarker),
  );
}

export function classifyManagedProcesses(records, snapshotsByPid, context) {
  const live = [];
  const dead = [];
  const conflicts = [];
  for (const record of records) {
    const snapshot = snapshotsByPid.get(record.pid);
    if (!snapshot) {
      dead.push(record);
    } else if (processIdentityMatches(record, snapshot, context)) {
      live.push(record);
    } else {
      conflicts.push(record);
    }
  }
  return {
    live,
    dead,
    conflicts,
    killablePids: conflicts.length === 0 ? live.map((record) => record.pid) : [],
  };
}

const ENV_FILE_OWNED_KEYS = new Set([
  'NODE_ENV', 'PORT', 'LISTEN_HOST', 'LOCAL_SAFE_MODE', 'DATABASE_URL',
  'ACTION_TOKEN_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_KEY_ID',
  'PROVIDER_KEY_ENCRYPTION_KEY', 'MEDIA_ENCRYPTION_KEY', 'STORAGE_BACKEND',
  'PLATFORM_SERVICES_ENABLED', 'PLATFORM_ASR_PROVIDER', 'PLATFORM_OCR_PROVIDER',
  'PLATFORM_MODERATION_PROVIDER', 'PLATFORM_SCAN_PROVIDER', 'WECHAT_ILINK_ENABLED',
  'ARK_API_KEY', 'ARK_MODEL',
]);

export function createSafeChildEnvironment(baseEnvironment = process.env) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const normalized = key.toUpperCase();
    const secretLike = /(?:TOKEN|SECRET|PASSWORD|API_KEY|ENCRYPTION_KEY)/.test(normalized);
    if (!ENV_FILE_OWNED_KEYS.has(normalized) && !secretLike) environment[key] = value;
  }
  return {
    ...environment,
    LISTEN_HOST: '127.0.0.1',
    LOCAL_SAFE_MODE: 'true',
    PLATFORM_SERVICES_ENABLED: 'false',
    WECHAT_ILINK_ENABLED: 'false',
    STORAGE_BACKEND: 'local',
  };
}

export function redactSensitiveText(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2')
    .replace(/\b(DATABASE_URL|ACTION_TOKEN_SECRET|ADMIN_PASSWORD|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*=\s*([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

export function buildRestoreInvocation(request, { retainOnFailureVerified = false } = {}) {
  if (request.action !== 'RestoreDrill') throw safetyBlock('restore invocation requires RestoreDrill');
  if (!retainOnFailureVerified) {
    throw safetyBlock('restore drill retain-on-failure capability is not verified');
  }
  return {
    args: [
      '--database', request.database,
      '--from', request.dumpName,
      '--target', request.restoreTarget,
    ],
  };
}

export async function runStartSequence(dependencies) {
  const managed = await dependencies.managedProcesses();
  if (managed.length > 0) return { alreadyRunning: true, processes: managed };

  const [backendPortOpen, frontendPortOpen] = await Promise.all([
    dependencies.portOpen(3000),
    dependencies.portOpen(5173),
  ]);
  if (backendPortOpen || frontendPortOpen) {
    const ports = [backendPortOpen && '3000', frontendPortOpen && '5173'].filter(Boolean).join(', ');
    throw safetyBlock(`external process occupies port ${ports}; Init and launch were not run`);
  }

  await dependencies.init();
  const created = [];
  try {
    created.push(await dependencies.launch('backend'));
    created.push(await dependencies.launch('frontend'));
    await dependencies.writeState(created);
    const [backendReady, frontendReady] = await Promise.all([
      dependencies.waitForHttp(BACKEND_READY_URL),
      dependencies.waitForHttp(FRONTEND_URL),
    ]);
    if (!backendReady || !frontendReady) {
      throw new Error('readiness failed for backend or frontend');
    }
    return { alreadyRunning: false, processes: created };
  } catch (error) {
    if (created.length > 0 && dependencies.stopCreated) {
      await dependencies.stopCreated(created);
    }
    throw error;
  }
}
