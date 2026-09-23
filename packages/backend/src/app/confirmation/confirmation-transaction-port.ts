import { Prisma } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import { err, internalError } from '@teacher-platform/contracts';
import { createPendingActionExecutionStore } from '../../features/pending-action/index.js';
import { createDatabaseConfirmableActionRegistry } from './database-confirmable-action-registry.js';
import type {
  ConfirmationTransactionPort,
  CreateConfirmationTransactionPortOptions,
  PaymentConfirmationReceiptStore,
} from './types.js';

class ConfirmationRollback extends Error {
  constructor(readonly result: Result<unknown, CommonError>) {
    super('confirmation transaction rollback');
  }
}

function createPaymentConfirmationReceiptStore(
  tx: Prisma.TransactionClient,
): PaymentConfirmationReceiptStore {
  return {
    async findPaymentCreateReceipt({ teacherId, pendingActionId }) {
      const payment = await tx.payment.findUnique({
        where: {
          teacherId_clientRequestId: {
            teacherId,
            clientRequestId: `agent-confirmed:${pendingActionId}`,
          },
        },
        select: { id: true, studentId: true, amount: true, lessonCount: true },
      });
      if (!payment) return null;
      const ledgerEntry = await tx.lessonLedgerEntry.findUnique({
        where: { paymentId: payment.id },
        select: {
          teacherId: true,
          studentId: true,
          entryType: true,
          lessonDelta: true,
          amount: true,
          paymentId: true,
        },
      });
      if (
        !ledgerEntry
        || ledgerEntry.teacherId !== teacherId
        || ledgerEntry.studentId !== payment.studentId
        || ledgerEntry.entryType !== 'purchase'
        || ledgerEntry.lessonDelta !== payment.lessonCount
        || ledgerEntry.amount !== payment.amount
        || ledgerEntry.paymentId !== payment.id
      ) return null;
      return {
        summary: `已为学生创建缴费记录：金额 ${payment.amount} 元、课时 ${payment.lessonCount} 节`,
        references: [{ type: 'Payment', id: payment.id }],
      };
    },
  };
}

export function createConfirmationTransactionPort(
  options: CreateConfirmationTransactionPortOptions,
): ConfirmationTransactionPort {
  const registryFactory = options.registryFactory ?? createDatabaseConfirmableActionRegistry;

  return {
    async run<T>(work: Parameters<ConfirmationTransactionPort['run']>[0]) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await options.rawPrisma.$transaction(async (tx) => {
            const result = await work({
              pendingActions: createPendingActionExecutionStore(tx),
              registry: registryFactory(tx),
              paymentReceipts: createPaymentConfirmationReceiptStore(tx),
            });
            if (!result.ok) throw new ConfirmationRollback(result);
            return result as Result<T, CommonError>;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (caught) {
          if (caught instanceof ConfirmationRollback) {
            return caught.result as Result<T, CommonError>;
          }
          if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2034' && attempt < 3) continue;
          return err(internalError('待确认操作执行失败'));
        }
      }
      return err(internalError('待确认操作执行失败'));
    },
  };
}
