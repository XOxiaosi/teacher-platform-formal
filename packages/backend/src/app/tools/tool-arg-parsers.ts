export function parseDateArg(value: unknown): Date | undefined | { error: true } {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return { error: true };
    return d;
  }
  return { error: true };
}

export function parsePageArg(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}
