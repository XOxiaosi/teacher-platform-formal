#!/usr/bin/env node
/**
 * verify-env-example：校验 packages/contracts/.env.example 与 deploy/DEPLOY.md §2 环境变量全表一致。
 *
 * P16 t4（backend5 t2 部署手册缺口 G1 闭合）：contracts .env.example 需按 DEPLOY.md §2 补齐占位。
 * 本脚本做三类机器检查：
 *   1. 语法：dotenv 语义子集逐行解析（注释/空行/KEY="value"/KEY=value），非法行 → 失败；
 *   2. 覆盖：DEPLOY.md §2 清单（12 域 94 变量）逐项必须出现在文件中（缺失 → 失败）；
 *      文件中的意外变量（清单外非注释行）→ 失败（.env.example 是 §2 的规范镜像，防漂移）；
 *   3. 密钥纪律：🔒 敏感变量值必须为空或 <占位> 形态（出现疑似真实密钥 → 失败）。
 *
 * 运行：npm -w @teacher-platform/contracts run env:verify
 * 可选：node scripts/verify-env-example.mjs [路径]（默认 packages/contracts/.env.example；负例测试/其他 env 模板可用）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(scriptDir, '..');
const envExamplePath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolve(contractsRoot, '.env.example');

/** DEPLOY.md §2 清单（来源 deploy/DEPLOY.md §2.1–2.12，P16 逐项核对；新增变量需同步更新本清单）。 */
const CHECKLIST = {
  '2.1 核心': [
    'NODE_ENV', 'PORT', 'LISTEN_HOST', 'ACTION_TOKEN_SECRET', 'LOG_LEVEL', 'LOCAL_SAFE_MODE',
    'SHUTDOWN_TIMEOUT_MS', 'SHUTDOWN_HANG', 'SHUTDOWN_PROBE_MS',
  ],
  '2.2 数据库': ['DATABASE_URL', 'MAX_DB_CLIENTS', 'DB_IDLE_TTL_MS', 'DB_SWEEP_INTERVAL_MS', 'DB_REGISTRY_CACHE_TTL_MS'],
  '2.3 加密': ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_ID', 'PROVIDER_KEY_ENCRYPTION_KEY', 'MEDIA_ENCRYPTION_KEY'],
  '2.4 媒体': ['MEDIA_STORAGE_ROOT'],
  '2.5 对象存储': [
    'STORAGE_BACKEND', 'STORAGE_LOCAL_ROOT', 'STORAGE_S3_ENDPOINT', 'STORAGE_S3_BUCKET',
    'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY', 'STORAGE_S3_REGION', 'STORAGE_S3_FORCE_PATH_STYLE',
  ],
  '2.6 平台服务': [
    'PLATFORM_SERVICES_ENABLED', 'PLATFORM_ASR_PROVIDER', 'PLATFORM_OCR_PROVIDER',
    'PLATFORM_MODERATION_PROVIDER', 'PLATFORM_MODERATION_LOCAL', 'PLATFORM_SCAN_PROVIDER',
    'PLATFORM_SCAN_CLAMAV_HOST', 'PLATFORM_SCAN_CLAMAV_PORT',
  ],
  '2.7 微信': [
    'WECHAT_ILINK_ENABLED', 'WECHAT_ILINK_APPID', 'WECHAT_ILINK_APPSECRET', 'WECHAT_ILINK_TOKEN',
    'WECHAT_ILINK_API_BASE_URL', 'WECHAT_ILINK_ALLOWED_IPS', 'WECHAT_ILINK_BOT_TOKEN',
    'WECHAT_ILINK_LONG_POLL_TIMEOUT_MS', 'WECHAT_ILINK_POLL_BACKOFF_MS', 'WECHAT_ILINK_MAX_POLL_FAILURES',
    'WECHAT_ILINK_CONTEXT_TOKEN_TTL_MS', 'WECHAT_ILINK_OUTBOUND_TIMEOUT_MS', 'WECHAT_ILINK_MAX_TEXT_LENGTH',
    'WECHAT_ILINK_STATE_TTL_MS', 'WECHAT_ILINK_TIMESTAMP_WINDOW_MS', 'WECHAT_ILINK_QRCODE_RATE_PER_MIN',
    'WECHAT_ILINK_CALLBACK_RATE_PER_MIN', 'WECHAT_ILINK_BIND_RATE_PER_MIN', 'WECHAT_ILINK_INBOUND_PER_MIN',
    'WECHAT_ILINK_NOTIFY_PER_MIN', 'WECHAT_ILINK_RECOVERY_INTERVAL_MS', 'WECHAT_ILINK_UNBOUND_MAX_PENDING_MS',
    'WECHAT_ILINK_WEBHOOK_TIMEOUT_MS', 'WECHAT_ILINK_MAX_STATE_KEYS',
  ],
  '2.8 后台管理': ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH'],
  '2.9 AI/LLM': ['ARK_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL', 'AGENT_DAILY_TOKEN_LIMIT', 'AGENT_TURN_TOKEN_LIMIT', 'PROVIDER_BASEURL_ALLOWED_IPS'],
  '2.10 限流': [
    'RATE_LIMIT_MAX_KEYS', 'RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX',
    'REGISTER_RATE_LIMIT_MAX', 'REGISTER_RATE_LIMIT_WINDOW_MS',
    'AGENT_RATE_LIMIT_WINDOW_MS', 'AGENT_RATE_LIMIT_MAX',
  ],
  '2.11 运维': [
    'BACKUP_ROOT', 'OPERATOR', 'ALERT_STATE_FILE', 'ALERT_THRESHOLD_5XX_RATE', 'ALERT_THRESHOLD_P95_MS',
    'ALERT_THRESHOLD_POOL_RATIO', 'ALERT_THRESHOLD_DB_RATIO', 'ALERT_COOLDOWN_MINUTES',
    'ALERT_WEBHOOK_URL', 'ALERT_EMAIL', 'METRICS_POOL_SIZE', 'METRICS_POOL_MAX',
    'METRICS_DB_CONNECTIONS', 'METRICS_DB_MAX', 'HEALTH_PROBE_URL', 'HEALTH_PROBE_TIMEOUT_MS',
  ],
  '2.12 测试专用': ['TEACHER_PLATFORM_TEST_DATABASE', 'TEST_MUTEX_SKIP', 'FIXTURE_PROBE_MS', 'FIXTURE_HANG'],
};

/** 🔒 敏感变量（DEPLOY.md §2 标记）：值必须为空或 <占位> 形态（不写任何真实密钥值纪律）。 */
const SENSITIVE_KEYS = new Set([
  'ACTION_TOKEN_SECRET',
  'ENCRYPTION_KEY',
  'PROVIDER_KEY_ENCRYPTION_KEY',
  'MEDIA_ENCRYPTION_KEY',
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_ACCESS_KEY_ID',
  'STORAGE_S3_SECRET_ACCESS_KEY',
  'WECHAT_ILINK_APPID',
  'WECHAT_ILINK_APPSECRET',
  'WECHAT_ILINK_TOKEN',
  'WECHAT_ILINK_BOT_TOKEN',
  'ADMIN_PASSWORD_HASH',
  'ARK_API_KEY',
  'ALERT_WEBHOOK_URL',
]);

/** dotenv 语义子集解析：返回 { key, value, lineNo }[] + 语法错误[]。 */
function parseEnvFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const entries = [];
  const errors = [];
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const match = body.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(`第 ${lineNo} 行语法无法解析（期望 KEY=value 或注释/空行）：${raw}`);
      return;
    }
    let value = match[2];
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key: match[1], value, lineNo });
  });
  return { entries, errors };
}

function main() {
  if (!existsSync(envExamplePath)) {
    process.stderr.write(`FAIL: 未找到 ${envExamplePath}\n`);
    process.exitCode = 1;
    return;
  }

  const failures = [];
  const { entries, errors } = parseEnvFile(envExamplePath);
  const present = new Map(entries.map((entry) => [entry.key, entry]));

  // 1) 语法
  if (errors.length > 0) {
    failures.push(`语法错误 ${errors.length} 处：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  // 1b) 重复键
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      failures.push(`重复变量：${entry.key}（第 ${entry.lineNo} 行）`);
    }
    seen.add(entry.key);
  }

  // 2) 覆盖 + 漂移
  const expected = new Set(Object.values(CHECKLIST).flat());
  const missing = [...expected].filter((key) => !present.has(key));
  const unexpected = [...present.keys()].filter((key) => !expected.has(key));
  if (missing.length > 0) {
    failures.push(`DEPLOY.md §2 清单缺失 ${missing.length} 项：${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    failures.push(
      `文件含清单外变量 ${unexpected.length} 项（.env.example 应为 §2 规范镜像；新增变量需同步 DEPLOY.md §2 与清单）：${unexpected.join(', ')}`,
    );
  }

  // 3) 密钥纪律：🔒 变量值必须为空或 <占位> 形态
  for (const key of SENSITIVE_KEYS) {
    const entry = present.get(key);
    if (!entry) continue; // 缺失已在上方报
    const value = entry.value.trim();
    if (value !== '' && !/^<.*>$/.test(value)) {
      failures.push(`🔒 ${key} 疑似真实密钥值（应为空或 <占位>；纪律：不写任何真实密钥值）`);
    }
  }

  // 输出分域覆盖表
  console.log(`.env.example 校验（${envExamplePath}）`);
  console.log('分域覆盖（DEPLOY.md §2 清单）：');
  let expectedTotal = 0;
  for (const [domain, keys] of Object.entries(CHECKLIST)) {
    const hit = keys.filter((key) => present.has(key)).length;
    expectedTotal += keys.length;
    console.log(`  §${domain.padEnd(14)} ${String(hit).padStart(2)}/${String(keys.length).padStart(2)}${hit === keys.length ? '' : '  ← 缺'}`);
  }
  console.log(`  合计：${present.size} 项在文件中，清单要求 ${expectedTotal} 项`);
  console.log('');

  if (failures.length > 0) {
    console.error(`FAIL（${failures.length} 类问题）：`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`PASS：语法可解析 / ${expected.size} 变量全覆盖 / 无清单外变量 / 🔒 密钥零真实值`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
