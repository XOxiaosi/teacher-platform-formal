import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function parseGitTree(buffer) {
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

export function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

export function createUiRetirementDisposition(retirement) {
  const paths = new Set(retirement.retiredFiles.map((entry) => entry.path));
  return (path) => {
    const oldDesignFolder = ['evidence/design-qa/', 'evidence/t010-audit/', 'evidence/ui-reference/'].some((prefix) => path.startsWith(prefix));
    if (!paths.has(path) && !oldDesignFolder) return null;
    return {
      disposition: 'H',
      targetPath: null,
      reason: 'V004 user-requested teacher UI retirement; recoverable outside active source tree; not a completed replacement UI',
      retirementEvidence: 'evidence/migration/UI-RESET-retired-files.json',
    };
  };
}

export async function walk(directory, relativeRoot = '') {
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
