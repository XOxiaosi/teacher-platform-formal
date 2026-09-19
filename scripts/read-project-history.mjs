import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receipt = JSON.parse(readFileSync(resolve(root, 'evidence/project-history/archive-receipt.json'), 'utf8'));
const archive = readFileSync(resolve(root, receipt.archive));
if (createHash('sha256').update(archive).digest('hex') !== receipt.sha256) throw new Error('历史归档校验失败');
const files = JSON.parse(gunzipSync(archive).toString('utf8'));
for (const entry of receipt.entries) {
  if (typeof files[entry.path] !== 'string'
      || createHash('sha256').update(files[entry.path]).digest('hex') !== entry.sha256) throw new Error('历史原文校验失败');
}
const name = process.argv[2];
if (name === '--list') console.log(Object.keys(files).join('\n'));
else if (Object.hasOwn(files, name)) process.stdout.write(files[name]);
else { console.error('请选择 --list 中的历史路径'); process.exitCode = 1; }
