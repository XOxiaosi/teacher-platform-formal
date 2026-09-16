import type { Prisma, PrismaClient } from '@prisma/client';
import type { SourceRef } from './types.js';

type Db = PrismaClient | Prisma.TransactionClient;

const TOOL_SOURCE_TYPE: Record<string, string> = {
  'students.get': 'Student',
  'students.list': 'Student',
  'students.balance': 'Student',
  'scheduling.list': 'Schedule',
  'lessons.list': 'Lesson',
  'payments.list': 'Payment',
  'feedback.list': 'ParentFeedback',
  'memos.list': 'Memo',
};

function versionOf(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function collect(value: unknown, type: string, refs: SourceRef[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, type, refs, depth + 1);
    return;
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : null;
  const version = versionOf(row.updatedAt ?? row.updatedAtTs ?? row.version ?? row.sourceVersion);
  if (id && version) refs.push({ type, id, version });
  for (const child of Object.values(row)) collect(child, type, refs, depth + 1);
}

/** Extracts only server-returned object ids plus their current version marker. */
export function sourceRefsFromQuery(toolName: string, args: unknown, result: unknown): SourceRef[] {
  const type = TOOL_SOURCE_TYPE[toolName];
  if (!type) return [];
  const refs: SourceRef[] = [];
  collect(result, type, refs);
  // A balance query returns an aggregate number. It has no version marker in
  // the public result, so do not invent one; the next query will fetch the
  // current student record before any write uses that balance.
  void args;
  const unique = new Map<string, SourceRef>();
  for (const ref of refs) unique.set(`${ref.type}:${ref.id}:${ref.version}`, ref);
  return [...unique.values()];
}

export function parseSourceRefs(value: unknown): SourceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SourceRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.type !== 'string' || !row.type || typeof row.id !== 'string' || !row.id
      || typeof row.version !== 'string' || !row.version) return null;
    refs.push({ type: row.type, id: row.id, version: row.version });
  }
  return refs;
}

async function currentVersion(db: Db, teacherId: string, ref: SourceRef): Promise<string | null> {
  const where = { id: ref.id, teacherId };
  let row: { updatedAtTs: Date } | null;
  switch (ref.type) {
    case 'Student': row = await db.student.findFirst({ where, select: { updatedAtTs: true } }); break;
    case 'Schedule': row = await db.schedule.findFirst({ where, select: { updatedAtTs: true } }); break;
    case 'Lesson': row = await db.lesson.findFirst({ where, select: { updatedAtTs: true } }); break;
    case 'Payment': row = await db.payment.findFirst({ where, select: { updatedAtTs: true } }); break;
    case 'ParentFeedback': row = await db.parentFeedback.findFirst({ where, select: { updatedAtTs: true } }); break;
    case 'Memo': row = await db.memo.findFirst({ where, select: { updatedAtTs: true } }); break;
    default: return null;
  }
  return row?.updatedAtTs.toISOString() ?? null;
}

/** Rechecks tenant ownership and the exact version captured by a query. */
export async function sourceRefsCurrent(db: Db, teacherId: string, refs: SourceRef[]): Promise<boolean> {
  for (const ref of refs) {
    if (await currentVersion(db, teacherId, ref) !== ref.version) return false;
  }
  return true;
}
