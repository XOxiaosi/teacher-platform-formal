import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateEntries,
  parseArgs,
  parseLogLine,
  percentile,
  readLogSource,
} from '../scripts/metrics-aggregate.mjs';

function requestLog({ ts, method = 'GET', path = '/api/v1/students', status = 200, durationMs = 100 }) {
  return {
    ts,
    level: 'info',
    msg: 'request completed',
    requestId: 'req_test',
    method,
    path,
    status,
    durationMs,
  };
}

test('parseArgs：--log-file / --window-minutes / 快照 env 透传', () => {
  const args = parseArgs(['--log-file', 'app.log', '--window-minutes', '10', '--pool-size', '80', '--pool-max', '100']);
  assert.equal(args.logFile, 'app.log');
  assert.equal(args.windowMinutes, 10);
  assert.equal(args.poolSize, 80);
  assert.equal(args.poolMax, 100);
  assert.throws(() => parseArgs(['--window-minutes', '0']), /正整数/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
});

test('parseLogLine：只接受 request completed 事件，非法行返回 null', () => {
  const ok = parseLogLine(JSON.stringify(requestLog({ ts: '2026-08-30T02:00:00.000Z' })));
  assert.equal(ok.method, 'GET');
  assert.equal(parseLogLine('not-json'), null);
  assert.equal(parseLogLine(JSON.stringify({ level: 'info', msg: 'shutdown started' })), null);
  assert.equal(parseLogLine(JSON.stringify(requestLog({ status: '200' }))), null); // status 非数字
  assert.equal(parseLogLine(''), null);
});

test('percentile：空数组 0；最近秩取位正确', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 75), 3);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

test('聚合正确性：请求量/状态分类/5xx 率/p95/端点分组', () => {
  const entries = [
    requestLog({ ts: '2026-08-30T02:00:01.000Z', status: 200, durationMs: 100, path: '/api/v1/students' }),
    requestLog({ ts: '2026-08-30T02:00:02.000Z', status: 201, durationMs: 200, path: '/api/v1/students' }),
    requestLog({ ts: '2026-08-30T02:00:03.000Z', status: 404, durationMs: 50, path: '/api/v1/students' }),
    requestLog({ ts: '2026-08-30T02:00:04.000Z', status: 500, durationMs: 5000, path: '/api/v1/students' }),
    requestLog({ ts: '2026-08-30T02:00:05.000Z', status: 503, durationMs: 9000, path: '/api/v1/payments' }),
    requestLog({ ts: '2026-08-30T01:00:00.000Z', status: 500, durationMs: 9999, path: '/api/v1/old' }), // 窗口外（1 小时前）
  ];
  const snapshot = aggregateEntries(entries, {
    windowMinutes: 5,
    generatedAt: '2026-08-30T02:01:00.000Z',
  });

  assert.equal(snapshot.totals.requests, 5); // 窗口外那条不计
  assert.deepEqual(snapshot.totals.byStatusClass, { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 2 });
  assert.equal(snapshot.errorRate5xx, 2 / 5);
  // durationMs 排序 [50,100,200,5000,9000] → p50=200, p95=9000, p99=9000
  assert.equal(snapshot.latency.p50Ms, 200);
  assert.equal(snapshot.latency.p95Ms, 9000);
  // 端点分组：students 4 请求 1 个 5xx；payments 1 请求 1 个 5xx
  assert.equal(snapshot.byEndpoint.length, 2);
  const students = snapshot.byEndpoint.find((e) => e.path === '/api/v1/students');
  assert.equal(students.requests, 4);
  assert.equal(students.error5xx, 1);
  const payments = snapshot.byEndpoint.find((e) => e.path === '/api/v1/payments');
  assert.equal(payments.requests, 1);
  assert.equal(payments.error5xx, 1);
});

test('聚合空输入：零值快照', () => {
  const snapshot = aggregateEntries([], { windowMinutes: 5, generatedAt: '2026-08-30T02:00:00.000Z' });
  assert.equal(snapshot.totals.requests, 0);
  assert.deepEqual(snapshot.totals.byStatusClass, { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 });
  assert.equal(snapshot.errorRate5xx, 0);
  assert.deepEqual(snapshot.byEndpoint, []);
});

test('readLogSource：剥离 UTF-8 BOM（Windows 重定向常见）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-bom-'));
  try {
    const file = join(dir, 'bom.log');
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"msg":"request completed"}\n')]));
    const text = readLogSource(file);
    assert.equal(text.charCodeAt(0), 0x7b); // '{'，无 BOM
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('快照可选字段透传：poolSize/poolMax/dbConnections/dbMaxConnections', () => {
  const snapshot = aggregateEntries([], {
    windowMinutes: 5,
    generatedAt: '2026-08-30T02:00:00.000Z',
    poolSize: 42,
    poolMax: 100,
    dbConnections: 8,
    dbMaxConnections: 100,
  });
  assert.equal(snapshot.poolSize, 42);
  assert.equal(snapshot.poolMax, 100);
  assert.equal(snapshot.dbConnections, 8);
  assert.equal(snapshot.dbMaxConnections, 100);
  assert.deepEqual(snapshot.lastAlertAt, {});
});
