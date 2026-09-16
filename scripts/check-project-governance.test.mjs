import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGovernance, validateGovernance } from './check-project-governance.mjs';

const baseline = loadGovernance();
function changed(file, before, after) {
  const bundle = structuredClone(baseline);
  assert.ok(bundle.files[file].includes(before), `fixture text missing: ${before}`);
  bundle.files[file] = bundle.files[file].replace(before, after);
  return bundle;
}
function rejects(bundle, expected) {
  assert.ok(validateGovernance(bundle).some((error) => expected.test(error)), expected.source);
}

test('current documents form a consistent, restorable governance baseline', () => {
  assert.deepEqual(validateGovernance(baseline), []);
});
test('reject duplicate document entry points', () => {
  const bundle = structuredClone(baseline);
  bundle.names.push('agent.md', 'product log.md');
  rejects(bundle, /重复入口/);
});
test('reject product and execution version drift', () => {
  rejects(changed('PRODUCT.md', '| 需求版本 | V009 |', '| 需求版本 | V010 |'), /版本不一致/);
});
test('reject missing requirements still referenced by tasks', () => {
  rejects(changed('PRODUCT.md', '## F13｜', '## F99｜'), /F13/);
});
test('reject implementation plans referencing unknown decisions', () => {
  rejects(changed('PROJECT_LOG.md', '| B01 | P2/A05', '| B99 | P2/A05'), /未知需求或决定/);
});
test('reject silent approval of pending business semantics', () => {
  rejects(changed('PRODUCT.md', '| B01 | 已核对家长反馈修改正文后，是否需要重新核对 | 待决定；',
    '| B01 | 已核对家长反馈修改正文后，是否需要重新核对 | 已确认；'), /B01.*待决定/);
});
test('reject completed tasks when delivery verification is still failing', () => {
  const bundle = structuredClone(baseline);
  const currentTask = bundle.files['PROJECT_LOG.md'].match(/\| 当前任务 \| (GOV-\d+|A\d{2}|P\d+)/)[1];
  bundle.files['PROJECT_LOG.md'] = bundle.files['PROJECT_LOG.md']
    .replace(/\| 当前任务状态 \|[^\n]+/, '| 当前任务状态 | 已完成 |')
    .replace(new RegExp(`(\\| ${currentTask} \\|[^\\n]*\\| )(?:未开始|进行中|等待确认|被阻塞|已完成|已取消)( \\|)`), '$1已完成$2')
    .replace(/\| 交付门禁 \|[^\n]+/, '| 交付门禁 | 失败 |');
  rejects(bundle, /未通过交付门禁/);
});
test('reject broken task dependencies', () => {
  rejects(changed('PROJECT_LOG.md', '| A01；集成依赖 A02 |', '| A99；集成依赖 A02 |'), /依赖不存在/);
});
test('reject missing evidence and invalid document anchors', () => {
  const bundle = changed('PROJECT_LOG.md', '(PRODUCT.md#待你决定与修改的内容)', '(PRODUCT.md#不存在)');
  rejects(bundle, /锚点不存在/);
  const missing = changed('PROJECT_LOG.md', '(evidence/product/V009-ADJUSTMENT-PLAN.md)', '(evidence/missing.md)');
  rejects(missing, /链接不存在/);
});
test('reject history rewrite and incomplete history reconstruction', () => {
  const bundle = structuredClone(baseline);
  bundle.files[bundle.manifest.logParts[0]] += '静默改写\n';
  rejects(bundle, /历史原文被改写/);
  bundle.manifest.logParts.reverse();
  rejects(bundle, /历史日志拼接不完整/);
});
test('reject uncoupled test and delivery check entry points', () => {
  const bundle = structuredClone(baseline);
  bundle.package.scripts.test = 'node scripts/run-tests-with-postgres.mjs';
  rejects(bundle, /未接入完整入口/);
});
test('reject removal of mandatory rules even when headings remain', () => {
  for (const rule of [
    '每次改动后都必须编写或更新相关测试',
    '运行项目完整自动化入口 `npm run check`',
    '任一必须检查失败或未执行，任务不能标为已完成或交付通过',
    '每次完成一项可独立描述的改动，都必须创建对应的 Git commit 后再交付',
    '这不是合格交付，也不是已验证可用的回滚点',
  ]) rejects(changed('AGENTS.md', rule, '可以跳过'), /缺少必要约束/);
});
test('reject undeclared phases and phase self-dependencies', () => {
  rejects(changed('PROJECT_LOG.md', '| 对应工作包及 P2 |', '| 对应工作包及 P99 |'), /依赖不存在/);
  rejects(changed('PROJECT_LOG.md', '| P2；数量规则依赖 B02 |', '| P3；数量规则依赖 B02 |'), /自引用/);
  rejects(changed('PROJECT_LOG.md', '阶段编号：P0、P1、P2、P3、P4、P5、P6。', '阶段编号：P0。'), /阶段定义/);
});
test('reject a tampered manifest even if its matching content is supplied', () => {
  const bundle = structuredClone(baseline);
  bundle.manifest.files.pop();
  rejects(bundle, /原始指纹/);
  const forged = structuredClone(baseline);
  forged.manifest.files[0].sha256 = 'replacement';
  forged.manifest.logSha256 = 'replacement';
  rejects(forged, /原始指纹/);
});

test('reject removal of interaction rules while the interaction heading remains', () => {
  for (const rule of [
    '默认用中文和产品语言沟通',
    '直接推进已授权的工作',
    '只追问会实质改变产品目标、验收或授权边界的问题',
    '回答状态问题后继续原任务',
    '用户明确要求停止时，立即停止当前任务及其子任务的执行',
  ]) rejects(changed('AGENTS.md', rule, '可自行省略'), /缺少必要约束/);
});

test('reject weakening of new-project Git requirements and repository boundaries', () => {
  for (const rule of [
    '每个新项目从创建开始必须纳入 Git 版本管理',
    '先确认项目目录和仓库归属',
    '不重复初始化或随意创建嵌套仓库',
    '完成首批验证后创建初始 commit',
    '不得把依赖、构建产物、密钥或真实教学资料提交到 Git',
  ]) rejects(changed('AGENTS.md', rule, '可自行省略'), /缺少必要约束/);
});

test('reject loss of continuous orchestration, stop checks and scope boundaries', () => {
  for (const rule of [
    '单个工作包、测试通过、commit 或子 Agent 完成都不是长任务结束条件',
    '选择并立即执行下一个已授权且依赖满足的任务',
    '阶段汇报使用进度消息，不以最终回复结束执行',
    '主 Agent 必须检查、整合和安排后续任务',
    '局部阻塞只暂停受影响任务',
    '最终回复前检查剩余任务',
    '只修改规则、评估或回答问题，不自动启动文档中列出的业务长任务',
    '不以连续推进扩大授权',
  ]) rejects(changed('AGENTS.md', rule, '可自行省略'), /缺少必要约束/);
});

test('reject missing or empty continuation state in the current projection', () => {
  for (const field of ['长任务目标及结束条件', '当前可执行任务', '被阻塞任务及解除条件']) {
    const row = baseline.files['PROJECT_LOG.md'].split('\n').find((line) => line.startsWith(`| ${field} |`));
    assert.ok(row);
    rejects(changed('PROJECT_LOG.md', row, ''), /缺少连续执行状态/);
    rejects(changed('PROJECT_LOG.md', row, `| ${field} |  |`), /缺少连续执行状态/);
  }
});

test('historical continuation fields cannot replace the current projection', () => {
  const row = baseline.files['PROJECT_LOG.md'].split('\n').find((line) => line.startsWith('| 当前可执行任务 |'));
  const bundle = changed('PROJECT_LOG.md', row, '');
  bundle.files['PROJECT_LOG.md'] += `\n## 旧续接快照\n${row}\n`;
  rejects(bundle, /缺少连续执行状态: 当前可执行任务/);
});
