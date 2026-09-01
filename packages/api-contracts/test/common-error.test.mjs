import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alreadyConsumed,
  budgetExceeded,
  internalError,
  notFound,
  permissionDenied,
  rateLimited,
  validationError,
  versionConflict,
} from '../dist/index.js';

test('通用错误工厂保留旧项目的错误代码语义', () => {
  assert.deepEqual(notFound('学生不存在'), {
    code: 'NOT_FOUND',
    message: '学生不存在',
  });
  assert.deepEqual(permissionDenied('不可查看'), {
    code: 'PERMISSION_DENIED',
    message: '不可查看',
  });
  assert.deepEqual(alreadyConsumed('请勿重复提交'), {
    code: 'ALREADY_CONSUMED',
    message: '请勿重复提交',
  });
  assert.deepEqual(internalError('服务不可用'), {
    code: 'INTERNAL_ERROR',
    message: '服务不可用',
  });
});

test('校验错误保留旧项目的可选 field 形状', () => {
  assert.deepEqual(validationError('姓名不能为空'), {
    code: 'VALIDATION_ERROR',
    message: '姓名不能为空',
    field: undefined,
  });
  assert.deepEqual(validationError('姓名不能为空', 'name'), {
    code: 'VALIDATION_ERROR',
    message: '姓名不能为空',
    field: 'name',
  });
});

test('冲突、频率和预算错误保留调用方依赖的固定字段', () => {
  assert.deepEqual(versionConflict(), {
    code: 'VERSION_CONFLICT',
    message: '记录已被其他操作更新，请刷新后重试',
    field: 'expectedUpdatedAt',
  });
  assert.deepEqual(rateLimited('操作过于频繁'), {
    code: 'RATE_LIMITED',
    message: '操作过于频繁',
    field: 'rate',
  });
  assert.deepEqual(budgetExceeded('本月额度不足'), {
    code: 'BUDGET_EXCEEDED',
    message: '本月额度不足',
    field: 'budget',
  });
});
