import assert from 'node:assert/strict';
import test from 'node:test';
import { err, ok } from '../dist/index.js';

test('ok 保留成功值并提供稳定的判别字段', () => {
  const result = ok({ id: 'student-001' });

  assert.deepEqual(result, {
    ok: true,
    value: { id: 'student-001' },
  });
});

test('err 保留错误并与成功结果明确区分', () => {
  const error = { code: 'INTERNAL_ERROR', message: '暂时不可用' };
  const result = err(error);

  assert.deepEqual(result, { ok: false, error });
});
