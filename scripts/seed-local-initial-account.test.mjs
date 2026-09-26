import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import { seedLocalInitialAccount } from './seed-local-initial-account.mjs';

const local = { NODE_ENV: 'development', LOCAL_SAFE_MODE: 'true', PLATFORM_SERVICES_ENABLED: 'false', DATABASE_URL: 'postgresql://postgres@127.0.0.1:6473/teacher_platform' };
test('local initial account stores a salted hash and never overwrites existing accounts', async () => {
  let account, workspace, transactions = 0;
  const prisma = {
    teacherRegistry: { findUnique: async ({where}) => { assert.equal(where.email, '123@example.test'); return account; },
      create: async ({data}) => { account = {id:'synthetic-initial',...data}; return account; } },
    teacherWorkspacePreference: { create: async ({data}) => { workspace = data; } },
    $transaction: async run => { transactions++; return run(prisma); },
  };
  await seedLocalInitialAccount(prisma, local);
  assert.equal(account.email, '123@example.test');
  assert.equal(Object.hasOwn(account, 'password'), false);
  const [algorithm,salt,hash] = account.passwordHash.split('$');
  assert.equal(algorithm, 'scrypt');
  assert.equal(Buffer.from(salt,'base64url').length,16);
  assert.equal(scryptSync('123',Buffer.from(salt,'base64url'),64).toString('base64url'),hash);
  assert.notEqual(scryptSync('wrong',Buffer.from(salt,'base64url'),64).toString('base64url'),hash);
  assert.deepEqual(workspace,{teacherId:'synthetic-initial',studioName:'初始教师工作室'});
  const previousHash = account.passwordHash;
  await seedLocalInitialAccount(prisma, local);
  assert.equal(account.passwordHash, previousHash);
  assert.equal(transactions,1);
});
test('rejects production, remote, shared or non-local-safe environments before querying', async () => {
  for (const patch of [{NODE_ENV:'production'},{LOCAL_SAFE_MODE:'false'},{PLATFORM_SERVICES_ENABLED:'true'},
    {DATABASE_URL:'postgresql://postgres@db.example.com:6473/app'},
    {DATABASE_URL:'postgresql://postgres@127.0.0.1:5432/app'},
    {DATABASE_URL:'postgresql://postgres@127.0.0.1:55432/app'}, {DATABASE_URL:''}]) {
    await assert.rejects(seedLocalInitialAccount({}, {...local,...patch}));
  }
});
