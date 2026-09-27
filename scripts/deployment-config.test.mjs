import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('deployment builds both production apps and runs the API behind TLS nginx', () => {
  const compose = read('compose.yaml');
  const dockerfile = read('deploy/Dockerfile');
  const nginx = read('deploy/nginx.conf');

  assert.match(dockerfile, /npm ci .*&& npm run build/);
  assert.match(dockerfile, /packages\/frontend\/dist/);
  assert.match(dockerfile, /packages\/admin\/dist/);
  assert.match(compose, /prisma migrate deploy/);
  assert.match(compose, /LOCAL_SAFE_MODE: "false"/);
  assert.match(compose, /WECHAT_ILINK_ENABLED: "false"/);
  assert.match(compose, /teacher-platform-db/);
  assert.match(compose, /\$\{WEB_PORT:-8443\}:443/);
  assert.doesNotMatch(compose, /5432:\d+/);
  assert.match(nginx, /listen 443 ssl/);
  assert.match(nginx, /proxy_pass http:\/\/backend:3001/);
  assert.match(nginx, /location \/admin\//);
});

test('deployment build context excludes local data, credentials, dependencies, and generated output', () => {
  const dockerignore = read('.dockerignore');
  for (const entry of ['.data', 'certs', '.env', 'node_modules', '**/dist', 'teacher-platform-local-data']) {
    assert.ok(dockerignore.includes(entry), `missing .dockerignore rule: ${entry}`);
  }
});
