import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAntiStorm,
  evaluateThresholds,
  loadState,
  loadThresholds,
  parseArgs,
  saveState,
} from '../scripts/alert-check.mjs';

function snapshot(overrides = {}) {
  return {
    generatedAt: '2026-08-30T02:00:00.000Z',
    windowMinutes: 5,
    totals: { requests: 100, byStatusClass: { '2xx': 95, '3xx': 0, '4xx': 0, '5xx': 5 } },
    latency: { p50Ms: 100, p95Ms: 500, p99Ms: 900 },
    errorRate5xx: 0.05,
    poolSize: 50,
    poolMax: 100,
    dbConnections: 50,
    dbMaxConnections: 100,
    byEndpoint: [],
    lastAlertAt: {},
    ...overrides,
  };
}

const THRESHOLDS = loadThresholds({});

test('parseArgs：--metrics-file / --health-url / --state-file', () => {
  const args = parseArgs(['--metrics-file', 'm.json', '--health-url', 'http://x/health', '--state-file', 's.json']);
  assert.equal(args.metricsFile, 'm.json');
  assert.equal(args.healthUrl, 'http://x/health');
  assert.equal(args.stateFile, 's.json');
  assert.throws(() => parseArgs([]), /用法/);
});

test('loadThresholds：默认值与 env 覆盖', () => {
  const defaults = loadThresholds({});
  assert.equal(defaults.error5xxRate, 0.05);
  assert.equal(defaults.p95Ms, 2000);
  assert.equal(defaults.poolRatio, 0.8);
  assert.equal(defaults.dbRatio, 0.8);
  assert.equal(defaults.cooldownMinutes, 30);
  const custom = loadThresholds({ ALERT_THRESHOLD_5XX_RATE: '0.1', ALERT_COOLDOWN_MINUTES: '5' });
  assert.equal(custom.error5xxRate, 0.1);
  assert.equal(custom.cooldownMinutes, 5);
});

test('阈值命中：5xx 率 / p95 / 池 / DB 连接各自触发正确级别', () => {
  const alerts = evaluateThresholds(snapshot({ errorRate5xx: 0.06, latency: { p95Ms: 2500 } }), THRESHOLDS);
  const keys = alerts.map((a) => a.key);
  assert.ok(keys.includes('ERROR_5XX_RATE_HIGH'));
  assert.ok(keys.includes('P95_LATENCY_HIGH'));
  const errorAlert = alerts.find((a) => a.key === 'ERROR_5XX_RATE_HIGH');
  assert.equal(errorAlert.level, 'critical');
  const p95Alert = alerts.find((a) => a.key === 'P95_LATENCY_HIGH');
  assert.equal(p95Alert.level, 'warning');
});

test('阈值命中：池使用率 ≥80% 与 DB 连接 ≥80%', () => {
  const alerts = evaluateThresholds(snapshot({ poolSize: 80, poolMax: 100, dbConnections: 90, dbMaxConnections: 100 }), THRESHOLDS);
  const keys = alerts.map((a) => a.key);
  assert.ok(keys.includes('POOL_NEAR_LIMIT'));
  assert.ok(keys.includes('DB_CONNECTIONS_NEAR_LIMIT'));
  assert.equal(alerts.find((a) => a.key === 'POOL_NEAR_LIMIT').level, 'warning');
  assert.equal(alerts.find((a) => a.key === 'DB_CONNECTIONS_NEAR_LIMIT').level, 'critical');
});

test('阈值不命中：正常指标无告警', () => {
  const alerts = evaluateThresholds(snapshot(), THRESHOLDS);
  assert.deepEqual(alerts, []);
});

test('缺快照字段（undefined）不触发该指标告警', () => {
  const alerts = evaluateThresholds(snapshot({ poolSize: undefined, dbConnections: undefined, latency: { p95Ms: undefined } }), THRESHOLDS);
  assert.deepEqual(alerts, []);
});

test('防风暴：同 key 冷却期内不重复触发；冷却后重新触发', () => {
  const now = new Date('2026-08-30T02:00:00.000Z');
  const alertSet = evaluateThresholds(snapshot({ errorRate5xx: 0.06 }), THRESHOLDS);

  // 第一次触发
  const first = applyAntiStorm(now, alertSet, {}, THRESHOLDS);
  assert.equal(first.triggers.length, 1);
  assert.equal(first.triggers[0].key, 'ERROR_5XX_RATE_HIGH');

  // 冷却期内（5 分钟后）同告警不重复
  const soon = new Date('2026-08-30T02:05:00.000Z');
  const second = applyAntiStorm(soon, alertSet, first.state, THRESHOLDS);
  assert.equal(second.triggers.length, 0);

  // 冷却期后（35 分钟）重新触发
  const later = new Date('2026-08-30T02:35:00.000Z');
  const third = applyAntiStorm(later, alertSet, second.state, THRESHOLDS);
  assert.equal(third.triggers.length, 1);
});

test('状态翻转恢复：指标回落后发恢复通知', () => {
  const now = new Date('2026-08-30T02:00:00.000Z');
  const alertSet = evaluateThresholds(snapshot({ errorRate5xx: 0.06 }), THRESHOLDS);
  const first = applyAntiStorm(now, alertSet, {}, THRESHOLDS);
  assert.equal(first.triggers.length, 1);

  // 指标恢复（无告警）→ 恢复通知
  const recovered = applyAntiStorm(new Date('2026-08-30T02:31:00.000Z'), [], first.state, THRESHOLDS);
  assert.equal(recovered.recoveries.length, 1);
  assert.equal(recovered.recoveries[0].key, 'ERROR_5XX_RATE_HIGH');
  assert.equal(recovered.recoveries[0].status, 'recovered');
});

test('告警输出格式：tool/ts/status/key/level/metric/value/threshold/message', () => {
  const now = new Date('2026-08-30T02:00:00.000Z');
  const alertSet = evaluateThresholds(snapshot({ errorRate5xx: 0.06 }), THRESHOLDS);
  const { triggers } = applyAntiStorm(now, alertSet, {}, THRESHOLDS);
  assert.equal(triggers.length, 1);
  const alert = triggers[0];
  assert.equal(alert.ts, now.toISOString());
  assert.equal(alert.status, 'active');
  for (const field of ['key', 'level', 'metric', 'value', 'threshold', 'message']) {
    assert.ok(field in alert, `缺少字段 ${field}`);
  }
});

test('状态文件读写往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alert-state-'));
  try {
    const stateFile = join(dir, 'state.json');
    saveState(stateFile, { ALERT_X: { status: 'active', lastTriggeredAt: 123 } });
    const loaded = loadState(stateFile);
    assert.equal(loaded.ALERT_X.status, 'active');
    assert.equal(loaded.ALERT_X.lastTriggeredAt, 123);
    assert.deepEqual(loadState(join(dir, 'missing.json')), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
