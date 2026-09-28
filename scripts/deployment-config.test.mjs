import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('deployment builds both production apps and runs the API behind TLS nginx', () => {
  const compose = read('compose.yaml');
  const dockerfile = read('deploy/Dockerfile');
  const nginx = read('deploy/nginx.conf');
  const frontendBuild = read('packages/frontend/vite.config.ts');

  assert.match(dockerfile, /FROM node:22\.19\.0-bookworm-slim AS build/);
  assert.match(dockerfile, /npm install --global npm@10\.9\.2/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ca-certificates openssl/);
  assert.match(dockerfile, /npm ci .*&& npm run build/);
  assert.match(dockerfile, /packages\/frontend\/dist/);
  assert.match(dockerfile, /packages\/admin\/dist/);
  assert.match(compose, /prisma migrate deploy/);
  assert.match(compose, /LOCAL_SAFE_MODE: "false"/);
  assert.match(compose, /WECHAT_ILINK_ENABLED: "false"/);
  assert.match(compose, /teacher-platform-db/);
  assert.match(compose, /teacher-platform-files:\/app\/\.data/);
  assert.match(compose, /\$\{WEB_PORT:-8443\}:443/);
  assert.doesNotMatch(compose, /5432:\d+/);
  assert.match(nginx, /listen 443 ssl/);
  assert.match(nginx, /proxy_pass http:\/\/backend:3001/);
  assert.match(nginx, /server_name _;\s+root \/usr\/share\/nginx\/html;/);
  assert.match(nginx, /location \/admin\//);
  assert.match(nginx, /try_files \$uri \$uri\/ \/admin\/index\.html;/);
  assert.match(frontendBuild, /main: resolve\(import\.meta\.dirname, 'index\.html'\)/);
  for (const page of ['preview', 'prototype-v009', 'assistant-workbench', 'design-review']) {
    assert.doesNotMatch(frontendBuild, new RegExp(`resolve\\(import\\.meta\\.dirname, '${page}\\.html'\\)`));
    assert.ok(nginx.includes(page), `deployment must block legacy ${page} entry`);
  }
  assert.match(nginx, /location ~ \^\/\(preview\|prototype-v009\|assistant-workbench\|design-review\)\\\.html\$ \{\s+return 404;/);
});

test('deployment build context excludes local data, credentials, dependencies, and generated output', () => {
  const dockerignore = read('.dockerignore');
  for (const entry of ['.data', 'certs', '.env', 'node_modules', '**/dist', 'teacher-platform-local-data']) {
    assert.ok(dockerignore.includes(entry), `missing .dockerignore rule: ${entry}`);
  }
});
