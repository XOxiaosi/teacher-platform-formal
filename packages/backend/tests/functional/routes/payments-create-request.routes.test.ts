import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentRouteDependencies } from '../../../src/app/composition/types.js';
import { createPaymentRouter } from '../../../src/app/routes/payments.routes.js';

const payload = { studentId: 'synthetic-student', amount: 200, lessonCount: 2, paidAt: '2026-09-22T12:00:00+08:00' };
async function invoke(body: unknown, teacherId: string | undefined = 'synthetic-teacher') {
  const createPayment = vi.fn(async () => ({ ok: true as const, value: { id: 'synthetic-payment' } }));
  const router = createPaymentRouter({ payments: { createPayment } } as unknown as PaymentRouteDependencies);
  const layers = router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> } }>;
  const route = layers.find(layer => layer.route?.path === '/payments' && layer.route.methods.post)?.route;
  if (!route) throw new Error('Missing payment route');
  let status = 0;
  let result: unknown;
  const response = { status(value: number) { status = value; return this; }, json(value: unknown) { result = value; return this; } };
  await route.stack[0].handle({ teacherId, body } as Request, response as Response);
  return { status, result, createPayment };
}

describe('payment creation request contract', () => {
  it.each([undefined, null, {}, { ...payload }, ...['', '  ', 42, [], {}].map(clientRequestId => ({ ...payload, clientRequestId }))])(
    'rejects a missing or invalid request identity before business writes (%j)', async body => {
      const result = await invoke(body);
      expect(result.status).toBe(400);
      expect(result.result).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'clientRequestId 必填', field: 'clientRequestId' } });
      expect(result.createPayment).not.toHaveBeenCalled();
    },
  );
  it('accepts the connected payment form payload and forwards a canonical request identity', async () => {
    const result = await invoke({ ...payload, clientRequestId: '  payment-request-1  ', teacherId: 'ignored-body-teacher' });
    expect(result.status).toBe(201);
    expect(result.createPayment).toHaveBeenCalledExactlyOnceWith({ ...payload, paidAt: new Date(payload.paidAt),
      teacherId: 'synthetic-teacher', clientRequestId: 'payment-request-1', note: undefined });
    expect(result.result).toEqual({ ok: true, data: { id: 'synthetic-payment' } });
  });
});
