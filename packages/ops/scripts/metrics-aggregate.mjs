#!/usr/bin/env node
/**
 * 指标聚合器（P7-P1 · t41，t38 设计 §3.1）。
 *
 * 读取 G1 结构化日志（stdout JSON 行，每行一个事件：
 * {ts, level, msg, requestId, teacherId, method, path, status, durationMs, ...}），
 * 聚合最近窗口内的请求指标，输出 JSON 指标快照（即 /metrics 数据源格式契约）。
 *
 * 用法：
 *   node packages/ops/scripts/metrics-aggregate.mjs < logs.jsonl            # stdin
 *   node packages/ops/scripts/metrics-aggregate.mjs --log-file app.log      # 文件
 *   node packages/ops/scripts/metrics-aggregate.mjs --log-file app.log --window-minutes 10
 *
 * 输出（/metrics 契约，与 backend3 t39 挂载的 GET /api/v1/metrics 同形状）：
 * {
 *   "generatedAt": "...Z",
 *   "windowMinutes": 5,
 *   "totals": { "requests": 1234, "byStatusClass": {"2xx":1100,"3xx":20,"4xx":100,"5xx":14} },
 *   "latency": { "p50Ms": 120.5, "p95Ms": 800.2, "p99Ms": 1500.1 },
 *   "errorRate5xx": 0.0113,
 *   "poolSize": 42, "poolMax": 100,
 *   "dbConnections": 8, "dbMaxConnections": 100,
 *   "byEndpoint": [ {"method":"GET","path":"/api/v1/students","requests":500,"error5xx":2,"p95Ms":300.1} ],
 *   "lastAlertAt": {}
 * }
 *
 * 说明：poolSize/dbConnections 为可选快照值（--pool-size/--db-connections 或
 * METRICS_POOL_SIZE/METRICS_DB_CONNECTIONS env 传入；聚合器自身不查库——库健康
 * 由 ops db-health-check 巡检）。byEndpoint 按 method+path 分组。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WINDOW_MINUTES = 5;

export function parseArgs(argv) {
  const args = { logFile: undefined, windowMinutes: DEFAULT_WINDOW_MINUTES, poolSize: undefined, poolMax: undefined, dbConnections: undefined, dbMaxConnections: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log-file') args.logFile = argv[++i];
    else if (arg === '--window-minutes') args.windowMinutes = Number(argv[++i]);
    else if (arg === '--pool-size') args.poolSize = Number(argv[++i]);
    else if (arg === '--pool-max') args.poolMax = Number(argv[++i]);
    else if (arg === '--db-connections') args.dbConnections = Number(argv[++i]);
    else if (arg === '--db-max') args.dbMaxConnections = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(args.windowMinutes) || args.windowMinutes < 1) {
    throw new Error('--window-minutes 必须是正整数');
  }
  return args;
}

/** 解析单行 JSON 日志；非法行 / 非 request completed 事件返回 null。 */
export function parseLogLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (entry.msg !== 'request completed') return null;
    if (typeof entry.method !== 'string' || typeof entry.path !== 'string') return null;
    if (typeof entry.status !== 'number' || typeof entry.durationMs !== 'number') return null;
    if (!entry.ts || Number.isNaN(new Date(entry.ts).getTime())) return null;
    return entry;
  } catch {
    return null;
  }
}

/** 读取日志源：--log-file 或 stdin。剥离 UTF-8 BOM（PowerShell 重定向常见）。 */
export function readLogSource(logFile) {
  const text = logFile ? readFileSync(logFile, 'utf8') : readFileSync(0, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 分位数（最近秩）：p ∈ (0,100]，排序后取 ceil(p/100*n)-1 位。 */
export function percentile(sortedValues, p) {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const index = Math.max(0, Math.ceil((p / 100) * n) - 1);
  return sortedValues[Math.min(index, n - 1)];
}

/**
 * 聚合日志行 → 指标快照。
 * @param {Array<object>} entries 已解析的 request completed 事件
 * @param {object} options { windowMinutes, poolSize, poolMax, dbConnections, dbMaxConnections, generatedAt }
 */
export function aggregateEntries(entries, options = {}) {
  const now = options.generatedAt ? new Date(options.generatedAt) : new Date();
  const windowMs = (options.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;
  const cutoff = now.getTime() - windowMs;

  const inWindow = entries.filter((entry) => new Date(entry.ts).getTime() >= cutoff);

  const byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const durations = [];
  const endpointMap = new Map();

  for (const entry of inWindow) {
    const cls = `${Math.floor(entry.status / 100)}xx`;
    if (Object.prototype.hasOwnProperty.call(byStatusClass, cls)) byStatusClass[cls] += 1;
    durations.push(entry.durationMs);

    const key = `${entry.method} ${entry.path}`;
    if (!endpointMap.has(key)) {
      endpointMap.set(key, { method: entry.method, path: entry.path, requests: 0, error5xx: 0, durations: [] });
    }
    const endpoint = endpointMap.get(key);
    endpoint.requests += 1;
    if (entry.status >= 500) endpoint.error5xx += 1;
    endpoint.durations.push(entry.durationMs);
  }

  durations.sort((a, b) => a - b);
  const requests = inWindow.length;
  const error5xx = byStatusClass['5xx'];
  const errorRate5xx = requests > 0 ? error5xx / requests : 0;

  const byEndpoint = [...endpointMap.values()]
    .map((endpoint) => {
      endpoint.durations.sort((a, b) => a - b);
      const p95 = percentile(endpoint.durations, 95);
      return {
        method: endpoint.method,
        path: endpoint.path,
        requests: endpoint.requests,
        error5xx: endpoint.error5xx,
        p95Ms: Math.round(p95 * 10) / 10,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  return {
    generatedAt: now.toISOString(),
    windowMinutes: options.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
    totals: { requests, byStatusClass },
    latency: {
      p50Ms: Math.round(percentile(durations, 50) * 10) / 10,
      p95Ms: Math.round(percentile(durations, 95) * 10) / 10,
      p99Ms: Math.round(percentile(durations, 99) * 10) / 10,
    },
    errorRate5xx: Math.round(errorRate5xx * 10000) / 10000,
    poolSize: options.poolSize,
    poolMax: options.poolMax,
    dbConnections: options.dbConnections,
    dbMaxConnections: options.dbMaxConnections,
    byEndpoint,
    lastAlertAt: {},
  };
}

/** 主入口：聚合并输出 JSON 快照。 */
export function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = readLogSource(args.logFile);
  const entries = source
    .split(/\r?\n/)
    .map(parseLogLine)
    .filter((entry) => entry !== null);

  const snapshot = aggregateEntries(entries, {
    windowMinutes: args.windowMinutes,
    poolSize: args.poolSize ?? (process.env.METRICS_POOL_SIZE ? Number(process.env.METRICS_POOL_SIZE) : undefined),
    poolMax: args.poolMax ?? (process.env.METRICS_POOL_MAX ? Number(process.env.METRICS_POOL_MAX) : undefined),
    dbConnections: args.dbConnections ?? (process.env.METRICS_DB_CONNECTIONS ? Number(process.env.METRICS_DB_CONNECTIONS) : undefined),
    dbMaxConnections: args.dbMaxConnections ?? (process.env.METRICS_DB_MAX ? Number(process.env.METRICS_DB_MAX) : undefined),
  });

  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
