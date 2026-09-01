import { Prisma, type PrismaClient } from '@prisma/client';
import { err, internalError, ok } from '@teacher-platform/contracts';
import type { TrustedClock } from './types.js';

type ClockPrismaClient = Pick<PrismaClient, '$queryRaw'>;

export function createDatabaseTrustedClock(prisma: ClockPrismaClient): TrustedClock {
  return {
    async now() {
      try {
        const rows = await prisma.$queryRaw<Array<{ now: Date }>>(
          Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
        );
        const current = rows[0]?.now;
        if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
          return err(internalError('数据库可信时间不可用'));
        }
        return ok(current);
      } catch {
        return err(internalError('数据库可信时间不可用'));
      }
    },
  };
}
