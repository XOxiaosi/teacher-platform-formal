/** Real pinned DSH loop exercising the platform driver. Synthetic data only. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createPinnedTestHost } from './.a02-teaching-host.ts';
import { MockAdapter, textResponse, toolCallResponse } from './packages/core/agent-loop/tests/mock-adapter.ts';

const [root, driverPath, mode] = process.argv.slice(2);
assert(root && driverPath && mode);
assert(!Object.keys(process.env).some(key => /API_KEY|TOKEN|SECRET|PASSWORD/.test(key)));
globalThis.fetch = async () => { throw new Error('A02_EXTERNAL_NETWORK_PROHIBITED'); };
await mkdir(root, { recursive: true });
const { createDshTeachingRuntime } = await import(pathToFileURL(driverPath).href);
const usage = [];
let queries = 0;
const adapters: MockAdapter[] = [];
const host = createPinnedTestHost(join(root, 'sessions'), () => {
  const adapter = new MockAdapter(mode === 'create'
    ? [toolCallResponse('q1', 'students.balance', { studentId: 'synthetic-student-a' }), textResponse('合成学生剩余 8 课时，仅查询。')]
    : ['next', 'recover-failure', 'recover-deny'].includes(mode) ? [textResponse('继续该任务，请补充本次记录。')]
    : mode === 'deny' ? [toolCallResponse('q2', 'Shell', { command: 'must-never-execute' }), textResponse('拒绝未知工具。')]
    : mode === 'isolation' ? [toolCallResponse('q3', 'students.balance', { studentId: 'synthetic-student-b' }), textResponse('拒绝其他教师资料。')]
    : mode === 'cancel' ? ['hang'] : []);
  adapters.push(adapter);
  return adapter;
});
const driver = createDshTeachingRuntime({ host, onUsage: async record => { usage.push(record); } });
const runHost = host.run.bind(host);
host.run = async input => {
  try { return await runHost(input); }
  catch (error) { console.error('SYNTHETIC_HOST_FAILURE', error); throw error; }
};
const controller = new AbortController();
const input = { teacherId: 'synthetic-teacher-a', taskId: ['create', 'replay', 'next', 'replay-after-next'].includes(mode)
  ? 'synthetic-task-a' : mode === 'recover-failure' ? 'synthetic-failure'
    : ['recover-deny', 'replay-recovered-deny'].includes(mode) ? 'synthetic-deny' : `synthetic-${mode}`,
  executionId: mode === 'next' ? 'synthetic-execution-next' : 'synthetic-execution-a', message: '查询合成学生课时。',
  contextEpoch: 1, sessionRef: null, checkpoint: null, history: [], signal: controller.signal,
  tools: { definitions: [{ name: 'students.balance', description: '合成只读余额', sideEffect: 'read', parameters: {
    type: 'object', properties: { studentId: { type: 'string' } }, required: ['studentId'], additionalProperties: false,
  } }], async execute(name, args) {
    assert.equal(name, 'students.balance');
    if (args.studentId !== 'synthetic-student-a') return { ok: false, error: { code: 'NOT_FOUND', message: '合成隔离拒绝' } };
    queries++;
    return { ok: true, value: { remaining: 8, studentId: args.studentId } };
  } },
};
if (mode === 'next') {
  const { readFile } = await import('node:fs/promises');
  const previous = JSON.parse(await readFile(join(root, 'create.json'), 'utf8'));
  input.sessionRef = previous.output.value.sessionRef;
  input.checkpoint = previous.output.value.checkpoint;
}
if (mode === 'cancel') setTimeout(() => controller.abort(), 100);
const output = await driver.run(input);
if (mode === 'create') { assert(output.ok, JSON.stringify(output)); assert.equal(queries, 1); assert.equal(output.value.cost.modelCalls, 2); }
if (mode === 'replay' || mode === 'replay-after-next') {
  // Deliberately omit the platform checkpoint: upstream completed before the
  // platform saved it. Deterministic ownership must recover the existing turn.
  assert(output.ok, JSON.stringify(output)); assert.equal(queries, 0);
  assert.equal(adapters[0].requests.length, 0); assert.equal(usage[0].replayed, true);
  assert.equal(output.value.reply, '合成学生剩余 8 课时，仅查询。');
  assert.equal(output.value.cost.modelCalls, 2);
}
if (['next', 'recover-failure', 'recover-deny'].includes(mode)) {
  assert(output.ok, JSON.stringify(output)); assert.equal(queries, 0); assert.equal(adapters[0].requests.length, 1);
  assert.equal(usage[0].replayed, false);
}
if (mode === 'replay-recovered-deny') {
  assert(output.ok, JSON.stringify(output)); assert.equal(adapters[0].requests.length, 0);
  assert.equal(usage[0].replayed, true); assert.equal(output.value.reply, '继续该任务，请补充本次记录。');
}
if (['deny', 'isolation', 'failure', 'cancel'].includes(mode)) {
  assert.equal(output.ok, false, JSON.stringify(output)); assert.equal(queries, 0);
}
if (mode === 'failure') { assert.equal(usage[0].cost.usageStatus, 'unknown'); assert.equal(usage[0].cost.inputTokens, null); }
const summary = { mode, upstreamLoop: true, model: 'scripted-test-only', realProvider: false,
  queries, modelRequests: adapters.reduce((sum, adapter) => sum + adapter.requests.length, 0), output, usage };
await writeFile(join(root, `${mode}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
