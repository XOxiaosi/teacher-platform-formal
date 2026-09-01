/** True when Prisma reports that the selected database does not exist. */
export function isDatabaseMissingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'P1003') return true;
  return typeof candidate.message === 'string' && candidate.message.includes('does not exist');
}
