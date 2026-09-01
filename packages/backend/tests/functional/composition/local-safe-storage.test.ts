import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppStorageForMode } from '../../../src/app/composition/core-route-dependencies.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teacher-platform-local-safe-storage-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('L0 local-safe storage assembly', () => {
  it('local-safe 忽略恶意 S3 env，强制使用受控本地存储', async () => {
    const root = await temporaryRoot();
    const storage = createAppStorageForMode(true, {
      STORAGE_BACKEND: 's3',
      STORAGE_S3_ENDPOINT: 'https://attacker.invalid',
      STORAGE_S3_BUCKET: 'attacker-bucket',
      STORAGE_S3_ACCESS_KEY_ID: 'synthetic-access',
      STORAGE_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
      STORAGE_LOCAL_ROOT: '/tmp/attacker-controlled-root',
    }, root);

    const saved = await storage.save({
      exactRef: 'media/teacher-local-safe/asset/original',
      filename: 'original',
      content: 'local-only',
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.absolutePath).not.toMatch(/^s3:/);
    expect(await readFile(join(root, saved.value.fileRef), 'utf8')).toBe('local-only');
  });

  it('显式 opt-out 才保留 S3 env 的 fail-closed 装配语义', () => {
    expect(() => createAppStorageForMode(false, { STORAGE_BACKEND: 's3' }, '.data'))
      .toThrow(/SAFETY_BLOCK/);
  });
});
