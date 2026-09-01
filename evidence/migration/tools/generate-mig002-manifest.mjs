import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const targetRoot = resolve(new URL('../../../', import.meta.url).pathname);
const outputRoot = resolve(targetRoot, 'evidence/migration');
const partsRoot = resolve(outputRoot, 'MIG-002-manifest-parts');
const sourceA = '/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform';
const sourceB = '/Users/xiaosi/Desktop/OH-WorkSpace/teacher-platform-formal';
const fixedCommit = '8673884f57c9d23abdb26715913d6199b1b4d16b';
const baselineCommit = '5d73dd8fc6757aa637084ab88380b6c7003f1cea';
const backupPath = '/Users/xiaosi/Developer/migration-backups/teacher-platform-formal/pre-mig-2026-09-01.tar.gz';
const backupSha256 = 'e35c17395a93f788e045e67e96982e3f77b83914e6dca9271f5e8cbda59aac56';
const chunkSize = 400;

const includedRootScripts = new Set([
  'scripts/launcher-core.mjs',
  'scripts/smoke-built-backend.mjs',
  'scripts/test-mutex.mjs',
  'scripts/windows-controller-core.mjs',
  'scripts/windows-controller-core.test.mjs',
  'scripts/windows-controller.mjs',
]);

const omittedLegacyPackageFiles = new Set([
  'packages/backend/tests/functional/deploy/docker-config.test.ts',
  'packages/backend/tests/functional/deploy/pm2-config.test.ts',
  'packages/backend/tests/boundary/changelog-atomicity-boundary.test.ts',
  'packages/backend/tests/boundary/documentation-compaction-boundary.test.ts',
  'packages/backend/tests/boundary/feature-metadata-cleanup-boundary.test.ts',
  'packages/backend/tests/boundary/p29-w0-contract-boundary.test.ts',
  'packages/contracts/.env.example',
  'packages/frontend/PRODUCT.md',
]);

const safetyAdaptedPackageFiles = new Set([
  'packages/admin/vite.config.ts',
  'packages/backend/src/app/composition/core-route-dependencies.ts',
  'packages/backend/src/app/tool-registration.ts',
  'packages/backend/src/index.ts',
  'packages/backend/src/shared/ai-client/ark-provider.ts',
  'packages/backend/src/shared/ai-client/index.ts',
  'packages/backend/tests/functional/provider-usage/provider-usage-wiring.test.ts',
  'packages/backend/tests/boundary/build-runtime-contract-boundary.test.ts',
  'packages/backend/tests/e2e/admin-mount-smoke.test.ts',
  'packages/backend/tests/e2e/llm-line-workflow.test.ts',
  'packages/backend/vitest.config.ts',
  'packages/frontend/vite.config.ts',
  'scripts/smoke-built-backend.mjs',
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function classifySourceA(path) {
  if (omittedLegacyPackageFiles.has(path)) {
    return {
      disposition: 'H',
      targetPath: null,
      reason: path === 'packages/frontend/PRODUCT.md'
        ? 'legacy product snapshot would create a second active PRODUCT truth source; retain by commit and path'
        : path === 'packages/contracts/.env.example'
          ? 'legacy deployment environment template is unnecessary for the local-safe baseline; retain by commit and path'
          : path.includes('/functional/deploy/')
            ? 'test asserts excluded legacy deployment material and is retained by commit and path'
            : 'boundary test imports excluded reports, harness, task history, or root gate scripts; retain by commit and path',
    };
  }

  if (safetyAdaptedPackageFiles.has(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: path.endsWith('vite.config.ts')
        ? 'adapted in target to enforce loopback strictPort behavior'
        : 'adapted in target to make local-safe external-provider and credential behavior fail closed',
    };
  }

  if (path.startsWith('packages/')) {
    const isolated = /(^|\/)(push|wechat)(\/|$)|morning-brief|evening-review/u.test(path);
    return {
      disposition: 'T',
      targetPath: path,
      exitTask: 'T-033',
      exitCondition: 'replace with formal module, remove legacy package and exact file-size baseline, then pass full gates',
      reason: isolated
        ? 'legacy-only compile baseline; outbound behavior must be unreachable in safe mode'
        : 'legacy-only runtime/test baseline with permanent exit tasks',
    };
  }

  if (includedRootScripts.has(path)) {
    return {
      disposition: 'T',
      targetPath: path,
      exitTask: 'T-033',
      exitCondition: 'replace or delete the legacy-only script after formal runtime validation',
      reason: path === 'scripts/test-mutex.mjs'
        ? 'legacy backend isolated test runner imports this cross-process mutex directly'
        : 'candidate local baseline or Windows contract script; must pass safety review',
    };
  }

  if (['package.json', 'package-lock.json', '.gitignore'].includes(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: 'merge into the single root workspace; never overwrite formal constraints',
    };
  }

  if (path === '.dockerignore' || path.startsWith('.github/') || path.startsWith('deploy/')) {
    return { disposition: 'H', targetPath: null, reason: 'legacy deployment/CI is reference-only' };
  }

  if (
    path.startsWith('reports/')
    || path.startsWith('docs/')
    || path.startsWith('harness/')
    || path.startsWith('.ai-memory/')
    || path.startsWith('.learnings/')
  ) {
    return { disposition: 'H', targetPath: null, reason: 'history retained by fixed commit and path' };
  }

  return { disposition: 'H', targetPath: null, reason: 'legacy root material retained by commit reference' };
}

function parseGitTree(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/u);
      if (!match) throw new Error(`Cannot parse git tree record: ${record}`);
      const [, mode, type, blob, sizeText, path] = match;
      return { mode, type, blob, size: sizeText === '-' ? null : Number(sizeText), path };
    });
}

async function walk(directory, relativeRoot = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeRoot === '' ? entry.name : join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(...(await walk(resolve(directory, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function classifySourceB(path) {
  if (path.includes('/dist/') || path.startsWith('dist/')) {
    return { disposition: 'X', targetPath: null, reason: 'generated build output; rebuild in target' };
  }
  if (/^evidence\/ui-reference\/.*\.(png|jpg|jpeg)$/u.test(path)) {
    return { disposition: 'H', targetPath: path, reason: 'duplicate visual binary already protected in target' };
  }
  return {
    disposition: 'M1',
    targetPath: path,
    reason: 'merge newer formal truth, MIG-001, source, test, or configuration into target',
  };
}

async function writeParts(prefix, entries) {
  const parts = [];
  for (let index = 0; index < entries.length; index += chunkSize) {
    const chunk = entries.slice(index, index + chunkSize);
    const partNumber = String(parts.length + 1).padStart(3, '0');
    const fileName = `${prefix}-${partNumber}.jsonl`;
    const path = resolve(partsRoot, fileName);
    const content = `${chunk.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await writeFile(path, content, 'utf8');
    parts.push({ path: relative(targetRoot, path), entries: chunk.length, sha256: sha256(content) });
  }
  return parts;
}

function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

async function targetState(targetPath, sourceIdentity = {}) {
  if (!targetPath) return { targetStatus: 'omitted' };
  try {
    const content = await readFile(resolve(targetRoot, targetPath));
    const state = {
      targetStatus: 'present',
      targetSize: content.length,
      targetSha256: sha256(content),
    };
    if (sourceIdentity.blob) {
      state.contentMatchesSource = gitBlobSha(content) === sourceIdentity.blob;
    } else if (sourceIdentity.sha256) {
      state.contentMatchesSource = state.targetSha256 === sourceIdentity.sha256;
    }
    return state;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { targetStatus: 'missing' };
    }
    throw error;
  }
}

await mkdir(partsRoot, { recursive: true });

const treeBuffer = execFileSync(
  'git',
  ['-C', sourceA, '-c', 'core.quotePath=false', 'ls-tree', '-r', '-l', '-z', fixedCommit],
  { encoding: 'buffer' },
);
const sourceAEntries = parseGitTree(treeBuffer).map((entry) => ({
  source: 'A',
  sourceCommit: fixedCommit,
  ...entry,
  ...classifySourceA(entry.path),
}));
for (const entry of sourceAEntries) {
  Object.assign(entry, await targetState(entry.targetPath, { blob: entry.blob }));
}

const sourceBPaths = (await walk(sourceB)).sort();
const sourceBEntries = [];
for (const path of sourceBPaths) {
  const absolute = resolve(sourceB, path);
  const content = await readFile(absolute);
  const metadata = await stat(absolute);
  sourceBEntries.push({
    source: 'B',
    path,
    size: metadata.size,
    sha256: sha256(content),
    ...classifySourceB(path),
  });
}
for (const entry of sourceBEntries) {
  Object.assign(entry, await targetState(entry.targetPath, { sha256: entry.sha256 }));
}

const baselinePaths = execFileSync(
  'git',
  ['-C', targetRoot, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', baselineCommit],
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);
const targetBaselineEntries = baselinePaths.map((path) => ({
  source: 'N',
  baselineCommit,
  path,
  disposition: 'KEEP',
  targetPath: path,
  reason: 'protected pre-migration target asset',
}));
for (const entry of targetBaselineEntries) {
  Object.assign(entry, await targetState(entry.targetPath));
}

const aParts = await writeParts('source-a', sourceAEntries);
const bParts = await writeParts('source-b', sourceBEntries);
const nParts = await writeParts('target-baseline', targetBaselineEntries);

function dispositionCounts(entries) {
  return Object.fromEntries(
    [...new Set(entries.map((entry) => entry.disposition))]
      .sort()
      .map((disposition) => [disposition, entries.filter((entry) => entry.disposition === disposition).length]),
  );
}

const manifest = {
  schemaVersion: 1,
  migrationId: 'MIG-002',
  generatedAt: new Date().toISOString(),
  target: targetRoot,
  sources: {
    A: { path: sourceA, commit: fixedCommit, entries: sourceAEntries.length },
    B: { path: sourceB, entries: sourceBEntries.length, excludedDirectory: 'node_modules' },
    N: { path: targetRoot, baselineCommit, entries: targetBaselineEntries.length },
  },
  rollback: { backupPath, backupSha256, baselineCommit },
  counts: {
    sourceA: dispositionCounts(sourceAEntries),
    sourceB: dispositionCounts(sourceBEntries),
    targetBaseline: dispositionCounts(targetBaselineEntries),
  },
  parts: [...aParts, ...bParts, ...nParts],
  invariants: [
    'Every source A tracked file occurs exactly once across source-a parts.',
    'Source A content is identified by Git blob at the fixed commit, never by the working tree.',
    'Source B node_modules and all dist entries are excluded from migration.',
    'Temporary legacy assets require exit tasks and are not formal product completion.',
    'Every targetPath records whether the target is present and whether its current content still matches the source.',
    'The target baseline remains recoverable by local commit and external backup.',
  ],
};

const outputPath = resolve(outputRoot, 'MIG-002-bulk-baseline-manifest.json');
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output: outputPath,
  sourceA: sourceAEntries.length,
  sourceB: sourceBEntries.length,
  targetBaseline: targetBaselineEntries.length,
  parts: manifest.parts.length,
  counts: manifest.counts,
}, null, 2));
