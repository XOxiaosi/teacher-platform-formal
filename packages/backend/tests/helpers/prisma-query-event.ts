import { PrismaClient, type Prisma } from '@prisma/client';

export interface CapturedPrismaQuery {
  query: string;
  params: string;
}

export type AuditFieldSqlSource =
  | 'DATABASE_DEFAULT_COLUMN_OMITTED'
  | 'PRISMA_BIND_PARAMETER'
  | 'DATABASE_TIME_EXPRESSION'
  | 'OTHER_SQL_EXPRESSION';

export interface ParsedSqlRegion {
  fields: readonly string[];
  expressions: ReadonlyMap<string, string>;
}

export function createQueryEventPrismaClient(): {
  client: PrismaClient;
  events: CapturedPrismaQuery[];
} {
  const events: CapturedPrismaQuery[] = [];
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  client.$on('query', (event: Prisma.QueryEvent) => {
    events.push({ query: event.query, params: event.params });
  });
  return { client, events };
}

export function isStudentInsert(query: string): boolean {
  return /^\s*INSERT\s+INTO\s+(?:"[^"]+"\.)?"Student"\s*\(/i.test(query);
}

export function isStudentUpdate(query: string): boolean {
  return /^\s*UPDATE\s+(?:"[^"]+"\.)?"Student"\s+SET\s+/i.test(query);
}

function quotedIdentifiers(region: string): string[] {
  return [...region.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function splitSqlList(region: string): string[] {
  return region.split(',').map((part) => part.trim());
}

export function parseInsertRegion(query: string): ParsedSqlRegion {
  const match = query.match(
    /^\s*INSERT\s+INTO\s+(?:"[^"]+"\.)?"Student"\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
  );
  if (!match) throw new Error(`无法解析Student INSERT列区: ${query}`);
  const fields = quotedIdentifiers(match[1]);
  const values = splitSqlList(match[2]);
  if (fields.length !== values.length) throw new Error('Student INSERT列与值数量不一致');
  return {
    fields,
    expressions: new Map(fields.map((field, index) => [field, values[index]])),
  };
}

export function parseUpdateSetRegion(query: string): ParsedSqlRegion {
  const match = query.match(
    /^\s*UPDATE\s+(?:"[^"]+"\.)?"Student"\s+SET\s+([\s\S]+?)\s+WHERE\s+/i,
  );
  if (!match) throw new Error(`无法解析Student UPDATE SET区: ${query}`);
  const assignments = splitSqlList(match[1]);
  const expressions = new Map<string, string>();
  for (const assignment of assignments) {
    const assignmentMatch = assignment.match(/^"([^"]+)"\s*=\s*(.+)$/);
    if (!assignmentMatch) throw new Error(`无法解析Student UPDATE赋值: ${assignment}`);
    expressions.set(assignmentMatch[1], assignmentMatch[2].trim());
  }
  return { fields: [...expressions.keys()], expressions };
}

export function classifyFieldSource(
  region: ParsedSqlRegion,
  field: string,
): AuditFieldSqlSource {
  const expression = region.expressions.get(field);
  if (expression === undefined) return 'DATABASE_DEFAULT_COLUMN_OMITTED';
  if (/^\$\d+$/.test(expression)) return 'PRISMA_BIND_PARAMETER';
  if (/\b(?:CURRENT_TIMESTAMP|clock_timestamp)\s*(?:\(\s*\))?/i.test(expression)) {
    return 'DATABASE_TIME_EXPRESSION';
  }
  return 'OTHER_SQL_EXPRESSION';
}

export function bindParameterValue(event: CapturedPrismaQuery, expression: string): unknown {
  const match = expression.match(/^\$(\d+)$/);
  if (!match) throw new Error(`表达式不是bind parameter: ${expression}`);
  const params = JSON.parse(event.params) as unknown[];
  return params[Number(match[1]) - 1];
}
