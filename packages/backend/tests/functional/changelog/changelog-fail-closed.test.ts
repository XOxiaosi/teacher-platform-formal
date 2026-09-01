import { describe, expect, it } from 'vitest';
import { err, internalError, ok } from '@teacher-platform/contracts';
import {
  CHANGELOG_WRITE_FAILED_MESSAGE,
  createChangelogService,
  defaultChangelogFactory,
  requireChangelogWrite,
  type ChangeLogEntry,
} from '../../../src/shared/changelog/index.js';

const entry: ChangeLogEntry = {
  id: 'audit-entry',
  teacherId: 'teacher-1',
  timestamp: new Date(0),
  module: 'students',
  action: 'create',
  targetType: 'Student',
  targetId: 'student-1',
  before: null,
  after: null,
  diff: null,
  source: 'manual',
  operatorId: null,
};

describe('requireChangelogWrite', () => {
  it('accepts a successful recordChange Promise without returning audit data', async () => {
    await expect(requireChangelogWrite(Promise.resolve(ok(entry)))).resolves.toBeUndefined();
  });

  it('keeps createChangelogService as the default injectable factory', () => {
    expect(defaultChangelogFactory).toBe(createChangelogService);
  });

  it('throws only the fixed sentinel when recordChange returns Err', async () => {
    const untrusted = {
      ...internalError('untrusted database message with secret'),
      stack: 'untrusted stack with before/after payload',
      before: { secret: 'before-secret' },
      after: { secret: 'after-secret' },
    };

    let thrown: unknown;
    try {
      await requireChangelogWrite(Promise.resolve(err(untrusted)));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(CHANGELOG_WRITE_FAILED_MESSAGE);
    expect((thrown as Error).message).toBe('AUDIT_WRITE_FAILED');
    expect(JSON.stringify(thrown)).not.toContain('untrusted');
    expect(JSON.stringify(thrown)).not.toContain('before-secret');
    expect(JSON.stringify(thrown)).not.toContain('after-secret');
  });
});
