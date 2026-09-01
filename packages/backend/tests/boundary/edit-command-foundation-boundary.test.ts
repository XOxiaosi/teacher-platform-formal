import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editContractPath = resolve(__dirname, '../../../contracts/src/edit.ts');
const contractIndex = readFileSync(resolve(__dirname, '../../../contracts/src/index.ts'), 'utf8');
const contractTypes = readFileSync(resolve(__dirname, '../../../contracts/src/types.ts'), 'utf8');
const changelogTypes = readFileSync(resolve(__dirname, '../../src/shared/changelog/types.ts'), 'utf8');
const changelogIndex = readFileSync(resolve(__dirname, '../../src/shared/changelog/index.ts'), 'utf8');

function readEditContract(): string {
  return existsSync(editContractPath) ? readFileSync(editContractPath, 'utf8') : '';
}

describe('A5-I1a edit command shared contract', () => {
  it('uses a dedicated contracts module exported from the package root', () => {
    expect(existsSync(editContractPath)).toBe(true);
    expect(contractIndex).toContain("export * from './edit.js';");
  });

  it('freezes trusted edit sources and optimistic concurrency metadata', () => {
    const editContract = readEditContract();

    expect(editContract).toContain('export type EditCommandSource =');
    for (const source of ['manual-web', 'agent-confirmed', 'wechat-confirmed', 'system']) {
      expect(editContract).toContain(`| '${source}'`);
    }
    expect(editContract).toMatch(/export interface EditCommandMeta\s*\{/);
    expect(editContract).toMatch(/teacherId:\s*string;/);
    expect(editContract).toMatch(/expectedUpdatedAt\?:\s*string;/);
    expect(editContract).toMatch(/source:\s*EditCommandSource;/);
  });

  it('declares a dedicated VERSION_CONFLICT code and standard constructor', () => {
    expect(contractTypes).toContain("| 'VERSION_CONFLICT'");
    expect(contractTypes).toMatch(/versionConflict\s*=\s*\(\):\s*CommonError/);
    expect(contractTypes).toContain("code: 'VERSION_CONFLICT'");
    expect(contractTypes).toContain("message: '记录已被其他操作更新，请刷新后重试'");
    expect(contractTypes).toContain("field: 'expectedUpdatedAt'");
  });
});

describe('A5-I1b changelog source compatibility', () => {
  it('composes historical values with trusted edit command sources', () => {
    expect(changelogTypes).toMatch(
      /import type \{[^}]*EditCommandSource[^}]*\} from '@teacher-platform\/contracts';/,
    );
    expect(changelogTypes).toContain('export type LegacyChangeSource =');
    for (const source of ['ai-note', 'manual', 'push']) {
      expect(changelogTypes).toContain(`| '${source}'`);
    }
    expect(changelogTypes).toContain(
      'export type ChangeSource = LegacyChangeSource | EditCommandSource;',
    );
  });

  it('exports both the compatibility alias and complete source type', () => {
    expect(changelogIndex).toContain('LegacyChangeSource,');
    expect(changelogIndex).toContain('ChangeSource,');
  });
});
