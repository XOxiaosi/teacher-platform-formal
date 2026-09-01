import { Prisma } from '@prisma/client';
import {
  alreadyConsumed,
  err,
  internalError,
  notFound,
  ok,
  validationError,
} from '@teacher-platform/contracts';
import { toPendingActionData } from './pending-action-mapper.js';
import type {
  CreatePendingActionServiceOptions,
  PendingActionData,
  PendingActionExecutionStore,
} from './types.js';

type PendingActionPrisma = CreatePendingActionServiceOptions['prisma'];

function consumedError() {
  return err(alreadyConsumed('待确认操作已被占用或消费'));
}

function stateValidation(message: string) {
  return err(validationError(message, 'pendingActionId'));
}

function confirmationStateError(status: string) {
  if (status === 'executing' || status === 'consumed') return consumedError();
  if (status === 'cancelled') return stateValidation('待确认操作已取消');
  if (status === 'expired') return stateValidation('待确认操作已过期');
  return err(internalError('待确认操作状态异常'));
}

function cancellationStateError(status: string) {
  if (status === 'executing') return stateValidation('待确认操作正在执行');
  if (status === 'consumed') return stateValidation('待确认操作已消费');
  if (status === 'expired') return stateValidation('待确认操作已过期');
  return err(internalError('待确认操作状态异常'));
}

export function createPendingActionExecutionStore(prisma: PendingActionPrisma): PendingActionExecutionStore {
  async function findOwned(pendingActionId: string, teacherId: string): Promise<PendingActionData | null> {
    const record = await prisma.pendingAction.findFirst({
      where: { id: pendingActionId, teacherId },
    });
    return record ? toPendingActionData(record) : null;
  }

  async function requireOwned(pendingActionId: string, teacherId: string) {
    const record = await findOwned(pendingActionId, teacherId);
    return record ? ok(record) : err(notFound('待确认操作不存在'));
  }

  return {
    async getDatabaseNow() {
      try {
        const rows = await prisma.$queryRaw<Array<{ now: Date }>>(
          Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
        );
        return rows[0]?.now
          ? ok(rows[0].now)
          : err(internalError('数据库可信时间不可用'));
      } catch {
        return err(internalError('数据库可信时间不可用'));
      }
    },

    async getOwned(input) {
      return requireOwned(input.pendingActionId, input.teacherId);
    },

    async claim(input) {
      const claimed = await prisma.pendingAction.updateMany({
        where: {
          id: input.pendingActionId,
          teacherId: input.teacherId,
          status: 'pending',
          expiresAtTs: { gt: input.databaseNow },
        },
        data: { status: 'executing', updatedAtTs: input.databaseNow },
      });
      if (claimed.count === 1) {
        const record = await requireOwned(input.pendingActionId, input.teacherId);
        return record.ok ? ok({ kind: 'claimed' as const, pendingAction: record.value }) : record;
      }

      const current = await requireOwned(input.pendingActionId, input.teacherId);
      if (!current.ok) return current;
      if (current.value.status === 'pending' && current.value.expiresAt <= input.databaseNow) {
        await prisma.pendingAction.updateMany({
          where: { id: input.pendingActionId, teacherId: input.teacherId, status: 'pending' },
          data: { status: 'expired', updatedAtTs: input.databaseNow },
        });
        const expired = await requireOwned(input.pendingActionId, input.teacherId);
        return expired.ok ? ok({ kind: 'expired' as const, pendingAction: expired.value }) : expired;
      }
      return confirmationStateError(current.value.status);
    },

    async markConsumed(input) {
      const consumed = await prisma.pendingAction.updateMany({
        where: { id: input.pendingActionId, teacherId: input.teacherId, status: 'executing' },
        data: { status: 'consumed', consumedAtTs: input.databaseNow, updatedAtTs: input.databaseNow },
      });
      if (consumed.count === 1) return requireOwned(input.pendingActionId, input.teacherId);

      const current = await requireOwned(input.pendingActionId, input.teacherId);
      if (!current.ok) return current;
      return confirmationStateError(current.value.status);
    },

    async cancel(input) {
      const cancelled = await prisma.pendingAction.updateMany({
        where: { id: input.pendingActionId, teacherId: input.teacherId, status: 'pending' },
        data: { status: 'cancelled', cancelledAtTs: input.databaseNow, updatedAtTs: input.databaseNow },
      });
      if (cancelled.count === 1) return requireOwned(input.pendingActionId, input.teacherId);

      const current = await requireOwned(input.pendingActionId, input.teacherId);
      if (!current.ok) return current;
      if (current.value.status === 'cancelled') return current;
      return cancellationStateError(current.value.status);
    },
  };
}
