import {
  err,
  ok,
  validationError,
  type CommonError,
  type EditCommandSource,
  type Result,
} from '@teacher-platform/contracts';
import type {
  PaymentChanges,
  PaymentData,
} from '../../../features/payments/types.js';
import type {
  UpdatePaymentCommand,
  UpdatePaymentResult,
  UpdatePaymentServices,
  UpdatePaymentUseCase,
} from './types.js';

const SOURCES = new Set<EditCommandSource>([
  'manual-web',
  'agent-confirmed',
  'wechat-confirmed',
  'system',
]);
const PAYMENT_FIELDS = new Set(['amount', 'lessonCount', 'paidAt', 'note']);
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface ValidatedCommand {
  teacherId: string;
  paymentId: string;
  expectedUpdatedAt?: Date;
  source: EditCommandSource;
  changes: PaymentChanges;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function parseRfc3339Instant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = RFC3339_INSTANT.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readChanges(value: unknown): Result<PaymentChanges, CommonError> {
  if (!isPlainObject(value)) {
    return err(validationError('changes 必须是对象', 'changes'));
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return err(validationError('至少提供一个缴费字段', 'changes'));
  }
  if (keys.some((key) => !PAYMENT_FIELDS.has(key))) {
    return err(validationError('changes 包含不允许的字段', 'changes'));
  }

  const changes: PaymentChanges = {};
  if (Object.hasOwn(value, 'amount')) {
    if (typeof value.amount !== 'number') return err(validationError('amount 必须是数字', 'amount'));
    changes.amount = value.amount;
  }
  if (Object.hasOwn(value, 'lessonCount')) {
    if (typeof value.lessonCount !== 'number') {
      return err(validationError('lessonCount 必须是数字', 'lessonCount'));
    }
    changes.lessonCount = value.lessonCount;
  }
  if (Object.hasOwn(value, 'paidAt')) {
    const paidAt = parseRfc3339Instant(value.paidAt);
    if (!paidAt) return err(validationError('paidAt 必须是带时区的RFC 3339时间', 'paidAt'));
    changes.paidAt = paidAt;
  }
  if (Object.hasOwn(value, 'note')) {
    if (typeof value.note !== 'string' && value.note !== null) {
      return err(validationError('note 必须是字符串或null', 'note'));
    }
    changes.note = value.note;
  }
  return ok(changes);
}

function validateCommand(command: UpdatePaymentCommand): Result<ValidatedCommand, CommonError> {
  const input = command as unknown as Record<string, unknown>;
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.paymentId !== 'string' || input.paymentId.trim() === '') {
    return err(validationError('paymentId 必须是非空字符串', 'paymentId'));
  }
  if (typeof input.source !== 'string' || !SOURCES.has(input.source as EditCommandSource)) {
    return err(validationError('source 不合法', 'source'));
  }

  const source = input.source as EditCommandSource;
  if (source !== 'system' && input.expectedUpdatedAt === undefined) {
    return err(validationError('expectedUpdatedAt 不能为空', 'expectedUpdatedAt'));
  }

  let expectedUpdatedAt: Date | undefined;
  if (input.expectedUpdatedAt !== undefined) {
    expectedUpdatedAt = parseRfc3339Instant(input.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return err(validationError('expectedUpdatedAt 必须是带时区的RFC 3339时间', 'expectedUpdatedAt'));
    }
  }

  const changes = readChanges(input.changes);
  if (!changes.ok) return changes;

  return ok({
    teacherId: input.teacherId,
    paymentId: input.paymentId,
    expectedUpdatedAt,
    source,
    changes: changes.value,
  });
}

function paymentSnapshot(payment: PaymentData): Record<string, unknown> {
  return {
    amount: payment.amount,
    lessonCount: payment.lessonCount,
    paidAt: payment.paidAt.toISOString(),
    note: payment.note,
    updatedAt: payment.updatedAt.toISOString(),
  };
}

export function createUpdatePaymentUseCaseWithServices(
  services: UpdatePaymentServices,
): UpdatePaymentUseCase {
  return {
    async updatePayment(command) {
      const validated = validateCommand(command);
      if (!validated.ok) return validated;

      return services.transaction<UpdatePaymentResult>(async (tx) => {
        const edited = await tx.payments.updatePayment({
          teacherId: validated.value.teacherId,
          paymentId: validated.value.paymentId,
          expectedUpdatedAt: validated.value.expectedUpdatedAt,
          changes: validated.value.changes,
        });
        if (!edited.ok) return edited;

        const audit = await tx.changelog.recordChange({
          teacherId: validated.value.teacherId,
          module: 'payments',
          action: 'update',
          targetType: 'Payment',
          targetId: edited.value.after.id,
          before: paymentSnapshot(edited.value.before),
          after: paymentSnapshot(edited.value.after),
          source: validated.value.source,
        });
        if (!audit.ok) return audit;

        return ok({
          value: edited.value.after,
          changeLogId: audit.value.id,
        });
      });
    },
  };
}
