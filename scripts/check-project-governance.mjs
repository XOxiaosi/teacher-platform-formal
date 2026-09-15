import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = ['AGENTS.md', 'PRODUCT.md', 'PROJECT_LOG.md'];
// Pinned at GOV-001 intake; editing the manifest alone cannot rewrite history.
const archiveBaseline = {
  'evidence/project-history/baseline-through-20260914.md': '2507eeabb408abf25208c816da601998543f8c439c86d192d6d271a5a6a6fdd2',
  'evidence/project-history/journal-through-20260914.md': 'a0b8ab6b285e13154bae9098c3c886c0cbc78f09eb8a7cd5c9809f8b1766ba62',
  'evidence/project-history/agent-rules-through-20260914.md': '3a2411ac51e9310efe8516fddc8d15f00260a828b3bc5013bc2161f4672c544b',
};
const archiveLogSha = '74c2df9c2484f9dcae169d7922bbb70709980e0fb53f4d0d46345c9700949ad1';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const rows = (text) => text.split('\n').filter((line) => line.startsWith('|'))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const section = (text, heading) => text.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
const codes = (text) => text.match(/\b(?:F\d{2}|D\d{2}|B\d{2})\b/g) ?? [];

export function loadGovernance(directory = root) {
  const files = Object.fromEntries(canonical.map((name) => [name, readFileSync(resolve(directory, name), 'utf8')]));
  const manifest = JSON.parse(readFileSync(resolve(directory, 'evidence/project-history/manifest.json'), 'utf8'));
  for (const entry of manifest.files) files[entry.path] = readFileSync(resolve(directory, entry.path), 'utf8');
  return {
    files, manifest, names: readdirSync(directory),
    package: JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')),
  };
}

export function validateGovernance(bundle, options = {}) {
  const { files, manifest, names } = bundle;
  const errors = [];
  const product = files['PRODUCT.md'] ?? '';
  const log = files['PROJECT_LOG.md'] ?? '';
  const agents = files['AGENTS.md'] ?? '';
  const exists = options.exists ?? ((path) => existsSync(resolve(root, path)));
  for (const name of canonical) if (!files[name]) errors.push(`缺少唯一入口 ${name}`);
  const aliases = new Set(['agent.md', 'agents.md', 'product.md', 'productlog.md']);
  for (const name of names) {
    if (!canonical.includes(name) && aliases.has(name.toLowerCase().replace(/[ _-]/g, ''))) {
      errors.push(`存在重复入口 ${name}`);
    }
  }
  for (const [name, text] of canonical.map((name) => [name, files[name] ?? ''])) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [rawPath, anchor] = target.split('#');
      const path = decodeURIComponent(rawPath || name);
      if (!(path in files) && !exists(path)) errors.push(`${name} 链接不存在: ${path}`);
      if (anchor && path in files) {
        const headings = [...files[path].matchAll(/^#+ (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/ /g, '-'));
        if (!headings.includes(decodeURIComponent(anchor))) errors.push(`${name} 锚点不存在: ${target}`);
      }
    }
  }
  const requirements = [...product.matchAll(/^## (F\d{2})｜/gm)].map((m) => m[1]);
  for (let n = 1; n <= 20; n++) {
    const code = `F${String(n).padStart(2, '0')}`;
    if (requirements.filter((value) => value === code).length !== 1) errors.push(`需求编号应唯一存在: ${code}`);
  }
  const decisions = rows(section(product, '待你决定与修改的内容'))
    .filter(([id]) => /^[DB]\d{2}$/.test(id));
  const known = new Set([...requirements, ...decisions.map(([id]) => id)]);
  for (const id of new Set(decisions.map(([id]) => id))) {
    if (decisions.filter(([code]) => code === id).length !== 1) errors.push(`决定编号重复: ${id}`);
  }
  for (const id of ['B01', 'B02']) {
    const decision = decisions.find(([code]) => code === id);
    if (!decision || !decision.slice(1).join(' ').includes('待决定')) errors.push(`${id} 必须保留为待决定`);
  }
  const plan = section(log, '当前执行计划');
  for (const id of codes(plan)) if (!known.has(id)) errors.push(`执行计划引用未知需求或决定: ${id}`);
  const phases = new Set((plan.match(/阶段编号：([^。]+)/)?.[1] ?? '').match(/P\d+/g) ?? []);
  if ([...phases].join(',') !== 'P0,P1,P2,P3,P4,P5,P6') errors.push('阶段定义缺失或无效');
  const tasks = rows(plan).filter(([id]) => /^(?:GOV-\d+|A\d{2}|P\d+)$/.test(id));
  const ids = tasks.map(([id]) => id);
  for (const id of new Set(ids)) if (ids.filter((value) => value === id).length !== 1) errors.push(`任务重复: ${id}`);
  for (const [id, refs, , dependencies, status] of tasks) {
    if (!codes(refs).length && !refs.includes('治理')) errors.push(`${id} 缺少需求关联`);
    if (!['未开始', '进行中', '等待确认', '被阻塞', '已完成', '已取消'].includes(status)) errors.push(`${id} 状态无效`);
    for (const dep of dependencies.match(/\b(?:A\d{2}|P\d+)\b/g) ?? []) {
      if ((!ids.includes(dep) && !phases.has(dep)) || dep === id) errors.push(`${id} 依赖不存在或自引用: ${dep}`);
    }
  }
  const projection = Object.fromEntries(rows(section(log, '当前投影')).map(([key, value]) => [key, value]));
  const version = rows(product).find(([key]) => key === '需求版本')?.[1];
  if (!version || !projection['需求版本']?.startsWith(version)) errors.push('产品与日志版本不一致');
  if (!projection['历史进度']?.includes('V008') || /\d+%/.test(projection['V009 进度'] ?? '')) {
    errors.push('旧进度不得作为 V009 完成率');
  }
  const currentTask = projection['当前任务']?.match(/GOV-\d+|A\d{2}|P\d/)?.[0];
  const task = tasks.find(([id]) => id === currentTask);
  if (!task || !projection['当前任务状态']?.startsWith(task[4])) errors.push('当前任务状态与计划不一致');
  if (task?.[4] === '已完成' && projection['交付门禁'] !== '通过') errors.push('未通过交付门禁不能标为已完成');
  for (const heading of ['三份文档的职责', '测试与交付门禁', 'Git 提交与回滚追踪']) {
    if (!agents.includes(`## ${heading}`)) errors.push(`缺少工作规则: ${heading}`);
  }
  const requiredRules = [
    ['测试必须更新', '每次改动后都必须编写或更新相关测试'],
    ['完整检查入口', '运行项目完整自动化入口 `npm run check`'],
    ['失败不得完成交付', '任一必须检查失败或未执行，任务不能标为已完成或交付通过'],
    ['改动必须提交', '每次完成一项可独立描述的改动，都必须创建对应的 Git commit 后再交付'],
    ['阻塞提交不算交付', '这不是合格交付，也不是已验证可用的回滚点'],
  ];
  for (const [label, rule] of requiredRules) if (!agents.includes(rule)) errors.push(`缺少必要约束: ${label}`);
  if (/V00[5-8].*(?:用户要求|必须|仅允许)/.test(agents)) errors.push('工作规则混入旧版产品要求');
  for (const name of ['check:governance', 'test:governance']) {
    if (!bundle.package.scripts[name]) errors.push(`缺少脚本 ${name}`);
  }
  if (!bundle.package.scripts.check?.includes('check:governance')
      || !bundle.package.scripts.test?.includes('test:governance')) errors.push('治理检查未接入完整入口');
  if (manifest.logSha256 !== archiveLogSha || manifest.files.length !== Object.keys(archiveBaseline).length
      || manifest.files.some((entry) => archiveBaseline[entry.path] !== entry.sha256 || entry.prefixLines !== 4)
      || new Set(manifest.files.map((entry) => entry.path)).size !== manifest.files.length) {
    errors.push('历史清单偏离 GOV-001 原始指纹');
  }
  const bodies = {};
  for (const entry of manifest.files) {
    const content = files[entry.path];
    if (content === undefined) { errors.push(`历史附件缺失: ${entry.path}`); continue; }
    bodies[entry.path] = content.split('\n').slice(entry.prefixLines).join('\n');
    if (digest(bodies[entry.path]) !== entry.sha256) errors.push(`历史原文被改写: ${entry.path}`);
  }
  if (digest(manifest.logParts.map((path) => bodies[path] ?? '').join('')) !== manifest.logSha256) {
    errors.push('历史日志拼接不完整');
  }
  return [...new Set(errors)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateGovernance(loadGovernance());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Project governance check passed: canonical documents, references, states, test entry points and history integrity.');
}
