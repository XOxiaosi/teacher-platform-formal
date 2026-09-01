#!/usr/bin/env node
/**
 * 告警检查脚本（P7-P1 · t41，t38 设计 §3.2/§3.3）。
 *
 * 输入：指标快照 JSON（metrics-aggregate.mjs 输出 或 GET /metrics 返回体），
 *       通过 --metrics-file 或 stdin 传入；可选 --health-url 复用 G4 探针语义。
 *
 * 阈值表（默认，env 可覆盖，t38 §3.3）：
 *   ALERT_THRESHOLD_5XX_RATE     5xx 错误率阈值（默认 0.05 = 5%）
 *   ALERT_THRESHOLD_P95_MS       p95 延迟阈值（默认 2000ms）
 *   ALERT_THRESHOLD_POOL_RATIO   连接池使用率阈值（默认 0.8）
 *   ALERT_THRESHOLD_DB_RATIO     DB 连接数使用率阈值（默认 0.8）
 *   ALERT_COOLDOWN_MINUTES       同告警防风暴冷却（默认 30 分钟）
 *   ALERT_STATE_FILE             状态文件路径（默认 %TEMP%/teacher-platform-alert-state.json）
 *
 * 通知（env 占位，未配置只记录不阻断）：
 *   ALERT_WEBHOOK_URL            通用 webhook（POST 告警 JSON）
 *   ALERT_EMAIL                  邮件收件人（占位：仅记日志，不实际发信）
 *
 * 语义：
 * - 命中阈值 → 输出告警 JSON；同 key 在冷却期内不重复（防风暴，状态翻转）；
 * - 指标恢复 → 输出恢复 JSON（状态翻转回退）；
 * - 命中告警 exit 1（供 cron/systemd 感知），无告警 exit 0。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_FILE = process.env.ALERT_STATE_FILE
  ?? (process.platform === 'win32'
    ? `${process.env.TEMP || 'C:/Windows/Temp'}/teacher-platform-alert-state.json`
    : '/var/lib/teacher-platform/alert-state.json');

export function parseArgs(argv) {
  const args = { metricsFile: undefined, healthUrl: undefined, stateFile: DEFAULT_STATE_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--metrics-file') args.metricsFile = argv[++i];
    else if (arg === '--health-url') args.healthUrl = argv[++i];
    else if (arg === '--state-file') args.stateFile = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!args.metricsFile && !args.healthUrl) {
    throw new Error('用法: alert-check --metrics-file <snapshot.json> [--health-url <url>] [--state-file <path>]');
  }
  return args;
}

export function loadThresholds(env = process.env) {
  return {
    error5xxRate: Number(env.ALERT_THRESHOLD_5XX_RATE ?? 0.05),
    p95Ms: Number(env.ALERT_THRESHOLD_P95_MS ?? 2000),
    poolRatio: Number(env.ALERT_THRESHOLD_POOL_RATIO ?? 0.8),
    dbRatio: Number(env.ALERT_THRESHOLD_DB_RATIO ?? 0.8),
    cooldownMinutes: Number(env.ALERT_COOLDOWN_MINUTES ?? 30),
  };
}

/** 读取指标快照：--metrics-file 或 stdin。剥离 UTF-8 BOM（Windows 重定向常见）。 */
export function readMetricsSource(metricsFile) {
  const text = metricsFile ? readFileSync(metricsFile, 'utf8') : readFileSync(0, 'utf8');
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(clean);
}

/** 读状态文件（不存在返回空对象）。 */
export function loadState(stateFile) {
  try {
    if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    // 状态文件损坏视为无状态，重新开始
  }
  return {};
}

/** 写状态文件（目录不存在自动创建）。 */
export function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * 阈值评估（纯函数，供单测）。
 * @param {object} snapshot metrics 快照
 * @param {object} thresholds 阈值
 * @returns {Array<{key:string,level:string,metric:string,value:number,threshold:number,message:string}>}
 */
export function evaluateThresholds(snapshot, thresholds) {
  const alerts = [];

  if (typeof snapshot.errorRate5xx === 'number' && snapshot.errorRate5xx > thresholds.error5xxRate) {
    alerts.push({
      key: 'ERROR_5XX_RATE_HIGH',
      level: 'critical',
      metric: 'errorRate5xx',
      value: snapshot.errorRate5xx,
      threshold: thresholds.error5xxRate,
      message: `5xx 错误率 ${(snapshot.errorRate5xx * 100).toFixed(1)}% 超过阈值 ${(thresholds.error5xxRate * 100).toFixed(0)}%`,
    });
  }

  if (typeof snapshot.latency?.p95Ms === 'number' && snapshot.latency.p95Ms > thresholds.p95Ms) {
    alerts.push({
      key: 'P95_LATENCY_HIGH',
      level: 'warning',
      metric: 'latency.p95Ms',
      value: snapshot.latency.p95Ms,
      threshold: thresholds.p95Ms,
      message: `p95 延迟 ${snapshot.latency.p95Ms}ms 超过阈值 ${thresholds.p95Ms}ms`,
    });
  }

  if (typeof snapshot.poolSize === 'number' && typeof snapshot.poolMax === 'number' && snapshot.poolMax > 0) {
    const ratio = snapshot.poolSize / snapshot.poolMax;
    if (ratio >= thresholds.poolRatio) {
      alerts.push({
        key: 'POOL_NEAR_LIMIT',
        level: 'warning',
        metric: 'poolSize/poolMax',
        value: ratio,
        threshold: thresholds.poolRatio,
        message: `连接池使用率 ${(ratio * 100).toFixed(0)}%（${snapshot.poolSize}/${snapshot.poolMax}）达到阈值 ${(thresholds.poolRatio * 100).toFixed(0)}%`,
      });
    }
  }

  if (typeof snapshot.dbConnections === 'number' && typeof snapshot.dbMaxConnections === 'number' && snapshot.dbMaxConnections > 0) {
    const ratio = snapshot.dbConnections / snapshot.dbMaxConnections;
    if (ratio >= thresholds.dbRatio) {
      alerts.push({
        key: 'DB_CONNECTIONS_NEAR_LIMIT',
        level: 'critical',
        metric: 'dbConnections/dbMaxConnections',
        value: ratio,
        threshold: thresholds.dbRatio,
        message: `DB 连接数使用率 ${(ratio * 100).toFixed(0)}%（${snapshot.dbConnections}/${snapshot.dbMaxConnections}）达到阈值 ${(thresholds.dbRatio * 100).toFixed(0)}%`,
      });
    }
  }

  return alerts;
}

/**
 * 防风暴过滤：结合状态文件，决定哪些告警真正触发/哪些恢复。
 * @returns {{triggers: Array, recoveries: Array, state: object}}
 */
export function applyAntiStorm(now, alerts, state, thresholds) {
  const cooldownMs = thresholds.cooldownMinutes * 60_000;
  const triggers = [];
  const recoveries = [];
  const nextState = { ...state };
  const activeKeys = new Set(alerts.map((alert) => alert.key));

  for (const alert of alerts) {
    const previous = nextState[alert.key];
    const lastTriggeredAt = previous?.lastTriggeredAt ?? 0;
    const isCooldown = previous?.status === 'active' && (now.getTime() - lastTriggeredAt) < cooldownMs;
    if (isCooldown) continue; // 防风暴：冷却期内同告警不重复
    triggers.push({ ...alert, ts: now.toISOString(), status: 'active' });
    nextState[alert.key] = { status: 'active', lastTriggeredAt: now.getTime() };
  }

  // 状态翻转回退：上次 active 但现在不再命中的告警 → 恢复通知
  for (const [key, record] of Object.entries(nextState)) {
    if (record?.status === 'active' && !activeKeys.has(key)) {
      recoveries.push({ key, ts: now.toISOString(), status: 'recovered', level: record.level ?? 'warning', message: `${key} 已恢复` });
      nextState[key] = { ...record, status: 'recovered' };
    }
  }

  return { triggers, recoveries, state: nextState };
}

/** 通知占位：webhook POST（配置时）+ email 记录（配置时）。不配置只记 stdout。 */
export async function notify(alert, env = process.env) {
  const webhookUrl = env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        process.stderr.write(`webhook 返回非 2xx: ${response.status}\n`);
      }
    } catch (error) {
      process.stderr.write(`webhook 发送失败: ${error.message}\n`);
    }
  }
  if (env.ALERT_EMAIL) {
    // 邮件通道占位（阶段三接 SMTP）：仅记录，不实际发信
    process.stderr.write(`[email-placeholder] 未配置 SMTP，告警 ${alert.key} 未发邮件（收件人 ${env.ALERT_EMAIL}）\n`);
  }
}

/** G4 探针语义复用：/health 连续失败告警（可选 --health-url）。 */
export async function checkHealthUrl(healthUrl, failThreshold = 3) {
  if (!healthUrl) return [];
  let failures = 0;
  for (let attempt = 0; attempt < failThreshold; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return [];
    } catch {
      failures += 1;
    }
  }
  if (failures >= failThreshold) {
    return [{
      key: 'HEALTH_READY_DOWN',
      level: 'critical',
      metric: 'health',
      value: failures,
      threshold: failThreshold,
      message: `/health 连续 ${failures} 次探测失败（${healthUrl}）`,
    }];
  }
  return [];
}

/** 主流程：读指标 → 阈值评估 → 防风暴 → 输出 → 通知 → exit 码。 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const thresholds = loadThresholds();
  const now = new Date();

  // 只有 --health-url 时不需要 metrics 快照（避免阻塞读 stdin）
  const snapshot = args.metricsFile ? readMetricsSource(args.metricsFile) : {};
  const healthAlerts = await checkHealthUrl(args.healthUrl);
  const alerts = [...evaluateThresholds(snapshot, thresholds), ...healthAlerts];

  const state = loadState(args.stateFile);
  const { triggers, recoveries, state: nextState } = applyAntiStorm(now, alerts, state, thresholds);

  if (triggers.length > 0 || recoveries.length > 0) {
    saveState(args.stateFile, nextState);
  }

  for (const event of [...recoveries, ...triggers]) {
    process.stdout.write(`${JSON.stringify({ tool: 'alert-check', ...event })}\n`);
    if (event.status === 'active') await notify(event);
  }

  if (triggers.length > 0) process.exitCode = 1;
  return { triggers, recoveries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
