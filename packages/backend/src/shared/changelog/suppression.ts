import { AsyncLocalStorage } from 'node:async_hooks';

const automaticChangelogSuppression = new AsyncLocalStorage<boolean>();

/** Run explicit audit work without also emitting Prisma extension changelogs. */
export function runWithAutomaticChangelogSuppressed<T>(work: () => T | PromiseLike<T>): Promise<T> {
  return automaticChangelogSuppression.run(true, async () => await work());
}

/** Whether automatic Prisma extension changelogs are suppressed for this async context. */
export function isAutomaticChangelogSuppressed(): boolean {
  return automaticChangelogSuppression.getStore() === true;
}
