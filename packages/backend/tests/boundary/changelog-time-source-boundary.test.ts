import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = resolve(process.cwd(), 'src/shared/changelog/changelog-service.ts');

function source(): string {
  return readFileSync(SOURCE_PATH, 'utf8');
}

describe('ChangeLog 审计时间源静态边界', () => {
  it('changelog-service 依赖 TrustedClock 并显式写 timestamp/createdAt', () => {
    const text = source();
    expect(text).toContain('createDatabaseTrustedClock');
    expect(text).toContain('const trustedClock = createDatabaseTrustedClock(prisma)');
    expect(text).toContain('timestampTs: now.value');
    expect(text).toContain('createdAtTs: now.value');
  });

  it('changelog-service 不产生无参 new Date()', () => {
    expect(source()).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
});
