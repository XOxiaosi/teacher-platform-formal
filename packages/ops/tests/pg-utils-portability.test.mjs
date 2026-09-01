import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { prependPathEntries } from '../lib/pg-utils.mjs';

test('prependPathEntries：PostgreSQL 候选前置且保持最高版本优先', () => {
  const bins = ['C:\\Program Files\\PostgreSQL\\17\\bin', 'C:\\Program Files\\PostgreSQL\\16\\bin'];
  const existing = ['C:\\legacy\\pgsql\\bin', 'C:\\Windows\\System32'].join(delimiter);

  assert.equal(prependPathEntries(existing, bins), [...bins, existing].join(delimiter));
});

test('prependPathEntries：空候选不改变既有 PATH', () => {
  assert.equal(prependPathEntries('/usr/local/bin:/usr/bin', []), '/usr/local/bin:/usr/bin');
});
