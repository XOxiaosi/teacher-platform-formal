import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  Result,
  CommonError,
  PaginationParams,
  EditCommandSource,
} from '@teacher-platform/contracts';

// ---- 变更动作 ----
export type ChangeAction = 'create' | 'update' | 'delete' | 'cancel' | 'restore';

// ---- 来源渠道 ----
export type LegacyChangeSource =
  | 'ai-note'
  | 'manual'
  | 'agent'
  | 'push';

export type ChangeSource = LegacyChangeSource | EditCommandSource;

// ---- 记录变更：输入 ----
export interface RecordChangeInput {
  teacherId: string;
  module: string;
  action: ChangeAction;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source: ChangeSource;
  operatorId?: string;
}

// ---- 查询变更日志：输入 ----
export interface QueryChangeLogsInput extends PaginationParams {
  teacherId: string;
  module?: string;
  targetType?: string;
  targetId?: string;
  action?: ChangeAction;
  dateFrom?: Date;
  dateTo?: Date;
}

// ---- 查询变更日志：输出 ----
export interface ChangeLogListResult {
  items: ChangeLogEntry[];
  total: number;
}

// ---- 变更日志条目（与 Prisma 模型对应） ----
export interface ChangeLogEntry {
  id: string;
  teacherId: string;
  timestamp: Date;
  module: string;
  action: ChangeAction;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: FieldDiff[] | null;
  source: ChangeSource;
  operatorId: string | null;
}

// ---- 字段级差异 ----
export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ---- 接口契约 ----
export interface ChangelogService {
  recordChange(input: RecordChangeInput): Promise<Result<ChangeLogEntry, CommonError>>;
  queryChangeLogs(input: QueryChangeLogsInput): Promise<Result<ChangeLogListResult, CommonError>>;
}

/** Injectable changelog factory for root clients and interactive transactions. */
export type ChangelogFactory = (
  prisma: PrismaClient | Prisma.TransactionClient,
) => Pick<ChangelogService, 'recordChange'>;