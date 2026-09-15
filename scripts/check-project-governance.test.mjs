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
  bundle.files['PROJECT_LOG.md'] = bundle.files['PROJECT_LOG.md']
    .replace(/\| 当前任务状态 \|[^\n]+/, '| 当前任务状态 | 已完成 |')
    .replace(/(\| GOV-001 \|[^\n]*\| )被阻塞( \|)/, '$1已完成$2')
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
