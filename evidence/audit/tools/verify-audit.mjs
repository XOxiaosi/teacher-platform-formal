#!/usr/bin/env node
// Read-only evidence checks. This does not make a failing product Gate pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const audit = resolve(root, 'evidence/audit/2026-09-08');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => readFile(resolve(root, path));
function safeTarget(path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  assert(rel && !isAbsolute(rel) && !rel.startsWith('..'), `Outside target: ${path}`);
  return absolute;
}
const summary = JSON.parse(await readFile(resolve(audit, 'inventory-summary.json'), 'utf8'));
const csv = (await readFile(resolve(audit, 'file-inventory.csv'), 'utf8')).trimEnd().split('\n');
const parseRow = (line) => [...line.matchAll(/"((?:[^"]|"")*)"(?=,|$)/g)].map((m) => m[1].replaceAll('""', '"'));
assert.deepEqual(parseRow(csv.shift()), ['path', 'category', 'bytes', 'lines', 'sha256', 'coverage']);
assert.equal(csv.length, summary.files);
const paths = new Set();
for (const line of csv) {
  const fields = parseRow(line);
  assert.equal(fields.length, 6);
  const [path, , bytes, , hash] = fields;
  assert(!paths.has(path), `Duplicate inventory path: ${path}`);
  paths.add(path);
  const content = await readFile(safeTarget(path));
  assert.equal(content.length, Number(bytes), `Size drift: ${path}`);
  assert.equal(sha(content), hash, `Inventory drift: ${path}`);
}
console.log(`INVENTORY_PASS files=${paths.size}; all recorded bytes and hashes match`);

const product = (await read('PRODUCT.md')).toString();
const log = (await read('PROJECT_LOG.md')).toString();
const current = log.split('## 产品需求变更记录')[0];
assert(product.includes('| 当前版本 | V003 |'));
assert(current.includes('| 当前产品版本 | V003 |'));
const tasks = current.split('\n').filter((line) => /^\| T-\d{3} \|/.test(line))
  .map((line) => line.split('|').slice(1, -1).map((v) => v.trim()));
const ids = new Set();
const statuses = new Set(['未开始', '进行中', '等待确认', '被阻塞', '已完成', '已取消']);
const gates = new Set(['未验证', '通过', '失败', '不适用']);
let total = 0;
let done = 0;
for (const task of tasks) {
  assert.equal(task.length, 20, `Invalid table: ${task[0]}`);
  assert(!ids.has(task[0]), `Duplicate task: ${task[0]}`);
  ids.add(task[0]);
  assert(statuses.has(task[12]), `Invalid status: ${task[0]}`);
  assert(gates.has(task[16]), `Invalid Gate: ${task[0]}`);
  const weight = Number(task[6]);
  assert(weight > 0);
  if (task[12] !== '已取消') total += weight;
  if (task[12] === '已完成') {
    assert.equal(task[16], '通过', `Completed without Gate: ${task[0]}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(task[17]) && task[18] !== '—');
    done += weight;
  } else if (task[16] === '未验证') assert.equal(task[17], '—', `False Gate date: ${task[0]}`);
}
assert.equal(total, 100);
assert.equal(done, 63);
assert(current.includes(`| 总任务进度 | ${done}% |`));
assert.equal(tasks.find((t) => t[0] === 'T-018')[12], '进行中');
console.log(`TRACKING_PASS tasks=${tasks.length} activeWeight=${total} completedWeight=${done}; PRODUCT unchanged at V003`);

const manifest = JSON.parse(await read('evidence/migration/MIG-002-bulk-baseline-manifest.json'));
const sourceKeys = new Set();
const targets = new Set();
let entries = 0;
for (const part of manifest.parts) {
  const content = await read(part.path);
  assert.equal(sha(content), part.sha256, `Part drift: ${part.path}`);
  const rows = content.toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, part.entries);
  for (const row of rows) {
    const key = `${row.source}:${row.path}`;
    assert(!sourceKeys.has(key), `Duplicate source disposition: ${key}`);
    sourceKeys.add(key);
    entries++;
    if (row.targetPath) {
      assert.equal(row.targetStatus, 'present', `Missing target: ${row.targetPath}`);
      assert(row.targetSha256, `Missing target hash: ${row.targetPath}`);
      const bytes = await readFile(safeTarget(row.targetPath));
      assert.equal(sha(bytes), row.targetSha256, `Recorded target drift: ${row.targetPath}`);
      targets.add(row.targetPath);
    }
  }
}
assert.equal(entries, 1161 + 79 + 17);
console.log(`MANIFEST_PASS parts=${manifest.parts.length} entries=${entries} uniqueHashedTargets=${targets.size}`);
const baseline = JSON.parse(await read('scripts/file-size-legacy-baseline.json'));
let exactMatches = 0;
for (const [path, record] of Object.entries(baseline.files)) {
  try {
    const bytes = await readFile(safeTarget(path));
    if (sha(bytes) === record.sha256 && bytes.toString().split(/\r\n|\n|\r/u).length === record.lines) exactMatches++;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
console.log(`LEGACY_BASELINE registered=${Object.keys(baseline.files).length} exactMatches=${exactMatches}; this is NOT strict file-size success`);
console.log('AUDIT_EVIDENCE_PASS; product integration remains FAILED per root-test.log and file-size-final.log');
