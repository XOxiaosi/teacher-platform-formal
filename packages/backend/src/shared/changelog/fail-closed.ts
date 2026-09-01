import type { CommonError, Result } from '@teacher-platform/contracts';
import type { ChangeLogEntry } from './types.js';

/**
 * Stable sentinel for fail-closed audit writes.
 *
 * Keep this value free of database details and changelog payloads: transaction
 * boundaries may log or surface the thrown error.
 */
export const CHANGELOG_WRITE_FAILED_MESSAGE = 'AUDIT_WRITE_FAILED';

type ChangelogWriteResult = Result<ChangeLogEntry, CommonError>;

/**
 * Require a changelog write to succeed before its surrounding transaction may
 * commit. It intentionally accepts only the Promise returned by recordChange,
 * keeping every call site in the same unambiguous form.
 */
export async function requireChangelogWrite(
  resultPromise: Promise<ChangelogWriteResult>,
): Promise<void> {
  const settled = await resultPromise;
  if (!settled.ok) {
    throw new Error(CHANGELOG_WRITE_FAILED_MESSAGE);
  }
}
