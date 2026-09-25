import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUiRetirementDisposition, gitBlobSha, parseGitTree } from './manifest-helpers.mjs';

test('parses fixed git tree without changing path or source identity', () => {
  const blob = 'a'.repeat(40);
  assert.deepEqual(parseGitTree(Buffer.from('100644 blob ' + blob + ' 4\tpackages/frontend/a.ts\0')), [
    { mode: '100644', type: 'blob', blob, size: 4, path: 'packages/frontend/a.ts' },
  ]);
  assert.throws(() => parseGitTree(Buffer.from('not a git record')));
});

test('git blob hashing matches the empty Git blob identity', () => {
  assert.equal(gitBlobSha(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('retirement affects exact removed UI files and old design folders only', () => {
  const disposition = createUiRetirementDisposition({ retiredFiles: [{ path: 'packages/frontend/src/features/auth/LoginPage.tsx' }] });
  for (const path of ['packages/frontend/src/features/auth/LoginPage.tsx', 'evidence/ui-reference/old.png', 'evidence/design-qa/old.md', 'evidence/t010-audit/old.jpg']) {
    assert.equal(disposition(path).disposition, 'H');
    assert.equal(disposition(path).targetPath, null);
  }
  for (const path of ['packages/frontend/src/api/auth.ts', 'packages/frontend/src/app/App.tsx', 'packages/backend/src/index.ts', 'packages/admin/src/app/App.tsx', 'PRODUCT.md']) {
    assert.equal(disposition(path), null);
  }
});
