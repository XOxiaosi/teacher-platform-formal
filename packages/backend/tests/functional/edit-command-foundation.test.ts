import { versionConflict } from '@teacher-platform/contracts';
import { describe, expect, it } from 'vitest';

describe('A5-I1 edit command foundation', () => {
  it('constructs the standard version conflict error', () => {
    expect(versionConflict()).toEqual({
      code: 'VERSION_CONFLICT',
      message: '记录已被其他操作更新，请刷新后重试',
      field: 'expectedUpdatedAt',
    });
  });
});
