import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import legacyBaseline from './file-size-legacy-baseline.json' with { type: 'json' };

const MAX_LINES = 500;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const generatedFiles = new Set(['package-lock.json']);
const checkedExtensions = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mts',
  '.prisma',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (
      entry.isFile()
      && !generatedFiles.has(entry.name)
      && checkedExtensions.has(extname(entry.name))
    ) {
      files.push(path);
    }
  }

  return files;
}

function countLines(content) {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\n|\r/u).length;
}

const violations = [];
const legacyMatches = [];
const advisories = [];
const files = await collectFiles(root);

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const lines = countLines(content);
  if (lines > MAX_LINES) {
    const path = relative(root, file);
    const baseline = legacyBaseline.files[path];
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (baseline?.lines === lines && baseline.sha256 === sha256) {
      legacyMatches.push(path);
      continue;
    }
    if (extname(file) === '.md') {
      advisories.push(`${path}: ${lines} lines`);
      continue;
    }
    violations.push(`${path}: ${lines} lines`);
  }
}

if (violations.length > 0) {
  console.error(`Files over ${MAX_LINES} lines:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`File-size check passed for new or modified files: ${files.length} text files, limit ${MAX_LINES} lines.`);
  if (legacyMatches.length > 0) {
    console.log(`Unchanged legacy exceptions (${legacyMatches.length}, source ${legacyBaseline.sourceCommit}, exit ${legacyBaseline.exitTask}):`);
    console.log(legacyMatches.join('\n'));
  }
  if (advisories.length > 0) {
    console.log(`Markdown files over the ${MAX_LINES}-line maintainability advisory (${advisories.length}):`);
    console.log(advisories.join('\n'));
  }
}
