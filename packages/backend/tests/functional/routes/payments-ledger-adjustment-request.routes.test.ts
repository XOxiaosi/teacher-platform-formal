import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentRouteDependencies } from '../../../src/app/composition/types.js';
import { createPaymentRouter } from '../../../src/app/routes/payments.routes.js';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function createDependencies() {
  const prepareAdjustment = vi.fn(async () => ({ ok: true as const, value: { confirmation: { id: 'confirmation-1' } } }));
  const confirmAdjustment = vi.fn(async () => ({ ok: true as const, value: { confirmation: { id: 'confirmation-1' } } }));
  return {
    dependencies: { payments: {}, ledger: { prepareAdjustment, confirmAdjustment } } as unknown as PaymentRouteDependencies,
    prepareAdjustment,
    confirmAdjustment,
  };
}

async function invoke(path: string, method: 'post', body: unknown, params: Record<string, string> = {}) {
  const { dependencies, prepareAdjustment, confirmAdjustment } = createDependencies();
  const router = createPaymentRouter(dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  if (!layer?.route) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  let status = 200;
  let response: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { response = value; return this; },
  } as Response;
  await layer.route.stack[0].handle({ teacherId: 'teacher-1', body, params } as unknown as Request, res);
  return { status, response, prepareAdjustment, confirmAdjustment };
}

describe('POST /lesson-ledger/adjustments request contract', () => {
  it.each([
    [undefined, 'body'], [null, 'body'], [[], 'body'], [{}, 'studentId'],
    [{ studentId: 's', entryType: 'gift', lessonDelta: 1, reason: 'r' }, 'clientRequestId'],
    [{ studentId: 's', entryType: 'unknown', lessonDelta: 1, reason: 'r', clientRequestId: 'id' }, 'entryType'],
    [{ studentId: 's', entryType: 'gift', lessonDelta: '1', reason: 'r', clientRequestId: 'id' }, 'lessonDelta'],
    [{ studentId: 's', entryType: 'gift', lessonDelta: 0, reason: 'r', clientRequestId: 'id' }, 'lessonDelta'],
    [{ studentId: 's', entryType: 'gift', lessonDelta: 2_147_483_648, reason: 'r', clientRequestId: 'id' }, 'lessonDelta'],
    [{ studentId: 's', entryType: 'gift', lessonDelta: 1, reason: '  ', clientRequestId: 'id' }, 'reason'],
  ])('rejects malformed body without invoking writes (%j)', async (body, field) => {
    const result = await invoke('/lesson-ledger/adjustments', 'post', body);
    expect(result.status).toBe(400);
    expect(result.response).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field } });
    expect(result.prepareAdjustment).not.toHaveBeenCalled();
  });

  it('canonicalizes the adjustment payload and ignores a forged teacher body field', async () => {
    const result = await invoke('/lesson-ledger/adjustments', 'post', {
      studentId: ' student-1 ', entryType: 'gift', lessonDelta: 2, reason: ' 补课 ', clientRequestId: ' adjustment-1 ', teacherId: 'attacker',
    });
    expect(result.status).toBe(201);
    expect(result.prepareAdjustment).toHaveBeenCalledExactlyOnceWith({
      teacherId: 'teacher-1', studentId: 'student-1', entryType: 'gift', lessonDelta: 2, reason: '补课', clientRequestId: 'adjustment-1',
    });
  });

  it('validates a missing confirmation id before it calls the ledger', async () => {
    const result = await invoke('/lesson-ledger/adjustments/:confirmationId/confirm', 'post', {}, { confirmationId: '   ' });
    expect(result.status).toBe(400);
    expect(result.response).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', field: 'confirmationId' } });
    expect(result.confirmAdjustment).not.toHaveBeenCalled();
  });
});
