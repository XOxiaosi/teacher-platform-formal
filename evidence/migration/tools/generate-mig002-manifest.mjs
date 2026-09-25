import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createUiRetirementDisposition, gitBlobSha, parseGitTree, walk } from './manifest-helpers.mjs';

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
const uiRetirement = JSON.parse(await readFile(resolve(outputRoot, 'UI-RESET-retired-files.json'), 'utf8'));
const uiRetirementDisposition = createUiRetirementDisposition(uiRetirement);

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

const captureAdaptedPackageFiles = new Set([
  'packages/backend/src/app/composition/core-route-dependencies.ts',
  'packages/backend/src/app/composition/types.ts',
  'packages/backend/src/app/routes/core.routes.ts',
  'packages/backend/tests/boundary/d48-historical-time-source-boundary.test.ts',
  'packages/backend/tests/fixtures/d47-audit-time-field-matrix.ts',
  'packages/backend/tests/fixtures/d48-historical-time-source-matrix.ts',
  'packages/contracts/prisma/schema.prisma',
  'packages/contracts/scripts/verify-empty-migration.mjs',
  'packages/frontend/src/app/App.tsx',
  'packages/frontend/src/app/routes.test.ts',
  'packages/frontend/src/app/routes.ts',
  'packages/frontend/src/features/ai-input/AiInputPage.test.tsx',
  'packages/frontend/src/features/ai-input/AiInputPage.tsx',
  'packages/frontend/src/features/ai-input/ai-input.css',
  'packages/ops/tests/db-tools.test.mjs',
]);

const identityAdaptedPackageFiles = new Set([
  'packages/admin/src/api/adminActions.test.ts',
  'packages/admin/src/api/adminActions.ts',
  'packages/admin/src/app/App.test.tsx',
  'packages/admin/src/pages/TeachersPage.test.tsx',
  'packages/admin/src/pages/TeachersPage.tsx',
  'packages/backend/src/app/middleware/rate-limit.ts',
  'packages/backend/src/app/routes/auth.routes.ts',
  'packages/backend/src/features/admin/admin-actions.ts',
  'packages/backend/src/features/admin/admin-auth-service.ts',
  'packages/backend/src/features/admin/admin.routes.ts',
  'packages/backend/src/features/admin/index.ts',
  'packages/backend/src/features/auth/index.ts',
  'packages/backend/tests/boundary/audit-time-field-matrix-boundary.test.ts',
  'packages/backend/tests/boundary/d48-historical-time-source-boundary.test.ts',
  'packages/backend/tests/e2e/admin-mount-smoke.test.ts',
  'packages/backend/tests/e2e/auth-boundary.test.ts',
  'packages/backend/tests/e2e/auth-flow.test.ts',
  'packages/backend/tests/e2e/idor-regression.test.ts',
  'packages/backend/tests/e2e/llm-line-workflow.test.ts',
  'packages/backend/tests/e2e/register-rate-limit.test.ts',
  'packages/backend/tests/e2e/wechat-mount-smoke.test.ts',
  'packages/backend/tests/fixtures/d47-audit-time-field-matrix.ts',
  'packages/backend/tests/fixtures/d48-historical-time-source-matrix.ts',
  'packages/backend/tests/functional/admin/admin-actions.test.ts',
  'packages/backend/tests/functional/admin/admin-audit-db.test.ts',
  'packages/backend/tests/functional/admin/admin-auth.test.ts',
  'packages/backend/tests/functional/admin/admin-usage-summary.test.ts',
  'packages/backend/tests/functional/admin/feedback-board.test.ts',
  'packages/backend/tests/functional/admin/feedback-summary.test.ts',
  'packages/backend/tests/functional/admin/interactions-health.test.ts',
  'packages/backend/tests/functional/admin/teacher-overview.test.ts',
  'packages/backend/tests/functional/auth/auth-service.test.ts',
  'packages/backend/tests/functional/privacy/privacy-api.test.ts',
  'packages/backend/tests/functional/provider-configs/provider-config-routes.test.ts',
  'packages/backend/tests/functional/provider-usage/usage-routes.test.ts',
  'packages/backend/tests/functional/wechat/wechat-ilink-login.test.ts',
  'packages/contracts/prisma/schema.prisma',
  'packages/contracts/scripts/verify-empty-migration.mjs',
  'packages/frontend/src/api/auth.test.ts',
  'packages/frontend/src/api/auth.ts',
  'packages/frontend/src/app/App.test.tsx',
  'packages/frontend/src/app/App.tsx',
  'packages/frontend/src/app/routes.test.ts',
  'packages/frontend/src/app/routes.ts',
  'packages/frontend/src/features/auth/LoginPage.test.tsx',
  'packages/frontend/src/features/auth/LoginPage.tsx',
  'packages/frontend/src/features/auth/RegisterPage.test.tsx',
  'packages/frontend/src/features/auth/RegisterPage.tsx',
  'packages/ops/tests/db-tools.test.mjs',
]);

const safetyAdaptedPackageFiles = new Set([
  'packages/admin/vite.config.ts',
  'packages/backend/src/app/composition/core-route-dependencies.ts',
  'packages/backend/src/app/tool-registration.ts',
  'packages/backend/src/index.ts',
  'packages/backend/src/shared/ai-client/ark-provider.ts',
  'packages/backend/src/shared/ai-client/index.ts',
  'packages/backend/scripts/run-tests-isolated.mjs',
  'packages/backend/tests/boundary/test-database-isolation-boundary.test.ts',
  'packages/backend/tests/functional/admin/feedback-summary.test.ts',
  'packages/backend/tests/functional/provider-usage/provider-usage-wiring.test.ts',
  'packages/backend/tests/boundary/build-runtime-contract-boundary.test.ts',
  'packages/backend/tests/e2e/admin-mount-smoke.test.ts',
  'packages/backend/tests/e2e/llm-line-workflow.test.ts',
  'packages/backend/tests/e2e/wechat-mount-smoke.test.ts',
  'packages/backend/vitest.config.ts',
  'packages/frontend/vite.config.ts',
  'packages/ops/tests/runtime-baseline.test.mjs',
  'scripts/smoke-built-backend.mjs',
]);

const productAdaptedPackageFiles = new Set([
  'packages/backend/src/app/agenda/agenda-query.ts',
  'packages/backend/src/app/routes/schedules.routes.ts',
  'packages/backend/src/app/use-cases/create-planned-schedule/create-planned-schedule-use-case.ts',
  'packages/backend/src/app/use-cases/create-planned-schedule/types.ts',
  'packages/backend/src/app/use-cases/schedule-complete/index.ts',
  'packages/backend/src/app/use-cases/schedule-complete/schedule-complete-use-case.ts',
  'packages/backend/src/app/use-cases/schedule-complete/types.ts',
  'packages/backend/src/features/lessons/lesson-service.ts',
  'packages/backend/src/features/lessons/types.ts',
  'packages/backend/src/features/scheduling/schedule-rescheduler.ts',
  'packages/backend/src/features/scheduling/schedule-service.ts',
  'packages/backend/src/features/scheduling/types.ts',
  'packages/backend/tests/e2e/api-core-workflow.test.ts',
  'packages/backend/tests/functional/agenda/agenda-query.test.ts',
  'packages/backend/tests/functional/lessons/lesson-service.test.ts',
  'packages/backend/tests/functional/use-cases/daily-review-assemble.test.ts',
  'packages/backend/tests/functional/use-cases/schedule-complete-audit-atomicity.test.ts',
  'packages/frontend/src/api/modules.test.ts',
  'packages/frontend/src/api/schedules.ts',
  'packages/frontend/src/api/types.ts',
  'packages/backend/src/app/agenda/agenda-projection.ts',
  'packages/backend/tests/functional/agenda/agenda-projection.test.ts',
  'packages/contracts/src/agenda.ts',
  'packages/frontend/package.json',
  'packages/frontend/src/app/App.test.tsx',
  'packages/frontend/src/app/App.tsx',
  'packages/frontend/src/app/AppShell.test.tsx',
  'packages/frontend/src/app/AppShell.tsx',
  'packages/frontend/src/app/routes.test.ts',
  'packages/frontend/src/app/routes.ts',
  'packages/frontend/src/features/agenda/agenda-time.test.ts',
  'packages/frontend/src/features/agenda/agenda-time.ts',
  'packages/frontend/src/features/agent/AgentTodayContext.test.tsx',
  'packages/frontend/src/features/agent/AgentTodayContext.tsx',
  'packages/frontend/src/features/ai-input/AiInputPage.test.tsx',
  'packages/frontend/src/features/ai-input/AiInputPage.tsx',
  'packages/frontend/src/features/ai-input/ai-input.css',
  'packages/frontend/src/features/dashboard/DashboardPage.test.tsx',
  'packages/frontend/src/features/dashboard/DashboardPage.tsx',
  'packages/frontend/src/features/daily-review/DailyReviewPage.test.tsx',
  'packages/frontend/src/features/daily-review/DailyReviewPage.tsx',
  'packages/frontend/src/features/schedules/SchedulesPage.test.tsx',
  'packages/frontend/src/features/schedules/SchedulesPage.tsx',
  'packages/frontend/src/features/schedules/WeekScheduleView.mobile.test.tsx',
  'packages/frontend/src/features/schedules/WeekScheduleView.test.tsx',
  'packages/frontend/src/features/schedules/WeekScheduleView.tsx',
  'packages/frontend/src/shared/agenda/AgendaItemView.tsx',
  'packages/frontend/src/shared/agenda/agenda-time.ts',
  'packages/frontend/src/styles/globals.css',
  'packages/frontend/src/styles/responsive-boundary.test.ts',
]);

function adaptationReason(path) {
  if (path.endsWith('vite.config.ts')) {
    return 'adapted in target to enforce loopback strictPort behavior';
  }
  if (
    path === 'packages/backend/scripts/run-tests-isolated.mjs'
    || path === 'packages/backend/tests/boundary/test-database-isolation-boundary.test.ts'
  ) {
    return 'adapted in target so backend tests require an explicit synthetic database and never read legacy .env';
  }
  if (path === 'packages/backend/tests/functional/admin/feedback-summary.test.ts') {
    return 'adapted in target to remove unrelated database-pool lifecycle from the focused admin route test';
  }
  if (path === 'packages/backend/tests/e2e/wechat-mount-smoke.test.ts') {
    return 'adapted in target so the process smoke timeout covers its two bounded startup and shutdown waits';
  }
  if (path === 'packages/ops/tests/runtime-baseline.test.mjs') {
    return 'adapted in target to replace excluded legacy deploy/CI assertions with the Active workspace test contract';
  }
  return 'adapted in target to make local-safe external-provider and credential behavior fail closed';
}

function productAdaptationReason(path) {
  if (
    path === 'packages/contracts/src/agenda.ts'
    || path === 'packages/backend/src/app/agenda/agenda-projection.ts'
    || path === 'packages/backend/tests/functional/agenda/agenda-projection.test.ts'
  ) {
    return 'adapted in target for the confirmed five-field course display contract without exposing legacy course titles';
  }
  if (path.startsWith('packages/frontend/src/features/ai-input/')) {
    return 'adapted in target for the confirmed mobile record-to-candidate interaction';
  }
  return 'adapted in target for the confirmed V002/V003 responsive web shell and Today interaction';
}

function captureAdaptationReason(path) {
  if (path.startsWith('packages/frontend/')) {
    return 'adapted in target for the confirmed T-015 web text draft, persisted capture review, and deletion-receipt flow';
  }
  if (path.includes('/composition/') || path.endsWith('/core.routes.ts')) {
    return 'adapted in target to mount the T-015 capture API while keeping legacy AI and media routes default closed';
  }
  return 'adapted in target for the T-015 persisted capture lifecycle, trusted timestamps, migration counts, and verification boundary';
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function classifySourceA(path) {
  const retired = uiRetirementDisposition(path);
  if (retired) return retired;
  if (['packages/frontend/src/app/App.tsx', 'packages/frontend/src/app/App.test.tsx', 'packages/frontend/src/main.tsx', 'packages/backend/tests/boundary/presentation-document-boundary.test.ts'].includes(path)) {
    return { disposition: 'M1', targetPath: path, reason: 'V004 teacher UI retirement: neutral non-operational entry and retained backend protocol boundaries; no replacement UI claimed' };
  }
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

  if (captureAdaptedPackageFiles.has(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: captureAdaptationReason(path),
    };
  }

  if (identityAdaptedPackageFiles.has(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: 'adapted for V003 invitation-only access, minimum-permission admin operations, session invalidation, and teacher isolation',
    };
  }

  if (safetyAdaptedPackageFiles.has(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: adaptationReason(path),
    };
  }

  if (productAdaptedPackageFiles.has(path)) {
    return {
      disposition: 'M1',
      targetPath: path,
      reason: productAdaptationReason(path),
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



function classifySourceB(path) {
  const retired = uiRetirementDisposition(path);
  if (retired) return retired;
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
  ...uiRetirementDisposition(path),
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
