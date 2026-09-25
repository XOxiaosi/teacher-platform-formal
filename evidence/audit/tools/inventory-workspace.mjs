#!/usr/bin/env node
// Read every in-scope regular file without following symlinks or reading private runtime data.
// This is coverage evidence, not a semantic code-review or secret-scanning claim.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'evidence/audit/2026-09-08');
const excludedDirectories = new Set([
  '.git', 'node_modules', 'dist', 'coverage', '.data', '.cache', '.vite',
  'backups', 'uploads', 'playwright-report', 'test-results',
]);
const textExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.css',
  '.html', '.sql', '.prisma', '.toml', '.yaml', '.yml', '.txt', '.sh', '.ps1', '.svg',
]);
const records = [];
const exclusions = [];
function category(path) {
  if (path === 'PRODUCT.md' || path === 'PROJECT_LOG.md') return 'canonical-facts';
  if (!path.includes('/') && path.endsWith('.md')) return 'root-reference-document';
  if (path.startsWith('evidence/')) return 'evidence';
  if (/test|spec|fixture/i.test(path)) return 'test-and-fixture';
  if (path.includes('/prisma/')) return 'schema-and-migration';
  if (path.startsWith('scripts/') || path.startsWith('packages/ops/')) return 'tooling-and-ops';
  if (path.includes('/src/')) return 'implementation';
  return 'configuration-and-assets';
}
async function walk(directory, prefix = '') {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      exclusions.push({ path, reason: 'symlink-not-followed' });
    } else if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || path === 'evidence/audit/2026-09-08') {
        exclusions.push({ path, reason: 'dependency-generated-private-or-audit-output' });
      } else await walk(absolute, path);
    } else if (entry.isFile()) {
      if (/^(\.env(?:\..*)?|\.DS_Store)$/.test(entry.name)
        || /\.(log|tsbuildinfo|pem|key|p12|pfx|sqlite|sqlite3|db|dump|bak|zip|gz)$/i.test(entry.name)) {
        exclusions.push({ path, reason: 'private-runtime-or-generated-file' });
        continue;
      }
      const content = await readFile(absolute);
      const isText = !content.includes(0) && (textExtensions.has(extname(path)) || entry.name.startsWith('.'));
      const lineCount = isText && content.length ? content.toString('utf8').split(/\r\n|\n|\r/u).length : isText ? 0 : null;
      records.push({ path, category: category(path), bytes: content.length, lines: lineCount,
        sha256: createHash('sha256').update(content).digest('hex'),
        coverage: isText ? 'complete-byte-read-and-line-inventory' : 'binary-byte-read-and-hash-only' });
    }
  }
}
await walk(root);
const fields = ['path', 'category', 'bytes', 'lines', 'sha256', 'coverage'];
const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = [fields, ...records.map((record) => fields.map((field) => record[field]))]
  .map((row) => row.map(quote).join(',')).join('\n') + '\n';
const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root }).toString().split('\0').filter(Boolean);
const summary = {
  generatedAt: new Date().toISOString(), root,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files: records.length, textFiles: records.filter((r) => r.lines !== null).length,
  bytes: records.reduce((sum, r) => sum + r.bytes, 0),
  textLines: records.reduce((sum, r) => sum + (r.lines ?? 0), 0),
  categories: Object.fromEntries([...new Set(records.map((r) => r.category))].map((cat) => [cat, records.filter((r) => r.category === cat).length])),
  worktree: { trackedChanges: status.filter((s) => !s.startsWith('??')).length, untrackedFiles: status.filter((s) => s.startsWith('??')).length },
  exclusions,
  limitation: 'Full byte-level inventory is not a claim of semantic review of every line. Audit outputs are excluded to avoid self-referential hashes. Never follow symlinks or read runtime credentials/data.',
};
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'file-inventory.csv'), csv);
await writeFile(resolve(output, 'inventory-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, exclusions: `${exclusions.length} entries (see inventory-summary.json)` }, null, 2));
