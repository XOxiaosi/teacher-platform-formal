import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentRouteDependencies } from '../../../src/app/composition/types.js';
import { createPaymentRouter } from '../../../src/app/routes/payments.routes.js';

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';
const OFFSET_FROM = '2026-09-01T08:00:00.000+08:00';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function createDependencies() {
  const listEntries = vi.fn(async () => ({ ok: true as const, value: [] }));
  const dependencies = {
    payments: {
      listPayments: vi.fn(),
      createPayment: vi.fn(),
    },
    ledger: {
      prepareAdjustment: vi.fn(),
      confirmAdjustment: vi.fn(),
      listEntries,
    },
  } as unknown as PaymentRouteDependencies;
  return { dependencies, listEntries };
}

async function invokeLedgerEntries(query: Record<string, unknown>) {
  const { dependencies, listEntries } = createDependencies();
  const router = createPaymentRouter(dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === '/lesson-ledger/entries' && candidate.route.methods.get
  ));
  if (!layer?.route) throw new Error('route not registered: GET /lesson-ledger/entries');

  let statusCode = 200;
  let responseBody: unknown;
  const req = { query, teacherId: 'teacher-1' } as unknown as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      responseBody = value;
      return this;
    },
  } as Response;

  await layer.route.stack[0].handle(req, res);
  return { statusCode, responseBody, listEntries };
}

describe('GET /lesson-ledger/entries date query validation', () => {
  it.each([
    ['invalid from', { from: 'not-a-date' }],
    ['invalid to', { to: '' }],
    ['repeated from', { from: [FROM, TO] }],
    ['repeated to', { to: [FROM, TO] }],
    ['inverted range', { from: TO, to: FROM }],
    ['equal range', { from: FROM, to: FROM }],
    ['normalized calendar date', { from: '2026-02-30T00:00:00.000Z' }],
    ['natural-language date', { from: 'September 1, 2026' }],
    ['timezone-less timestamp', { from: '2026-09-01T00:00:00' }],
  ])('rejects %s before querying the ledger', async (_name, query) => {
    const result = await invokeLedgerEntries(query);

    expect(result.statusCode).toBe(400);
    expect(result.responseBody).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'from/to 必须是合法 ISO 时间且 from < to',
        field: 'query',
      },
    });
    expect(result.listEntries).not.toHaveBeenCalled();
  });

  it.each([
    ['without bounds', {}, undefined, undefined],
    ['with from only', { from: FROM }, new Date(FROM), undefined],
    ['with to only', { to: TO }, undefined, new Date(TO)],
    ['with an explicit offset', { from: OFFSET_FROM }, new Date(OFFSET_FROM), undefined],
    ['with both bounds', { from: FROM, to: TO }, new Date(FROM), new Date(TO)],
  ])('accepts %s and forwards canonical dates', async (_name, query, from, to) => {
    const result = await invokeLedgerEntries(query);

    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toEqual({ ok: true, data: [] });
    expect(result.listEntries).toHaveBeenCalledTimes(1);
    expect(result.listEntries).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: undefined,
      from,
      to,
    });
  });
});

describe('GET /lesson-ledger/entries studentId query validation', () => {
  it.each([
    ['without studentId', {}, undefined],
    ['with one studentId', { studentId: 'student-1' }, 'student-1'],
    ['with surrounding whitespace', { studentId: '  student-1  ' }, 'student-1'],
  ])('accepts %s and forwards the canonical studentId', async (_name, query, studentId) => {
    const result = await invokeLedgerEntries(query);

    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toEqual({ ok: true, data: [] });
    expect(result.listEntries).toHaveBeenCalledTimes(1);
    expect(result.listEntries).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId,
      from: undefined,
      to: undefined,
    });
  });

  it.each([
    ['empty string', { studentId: '' }],
    ['whitespace only', { studentId: '   ' }],
    ['repeated values', { studentId: ['student-1', 'student-2'] }],
    ['number', { studentId: 1 }],
    ['object', { studentId: { id: 'student-1' } }],
    ['null', { studentId: null }],
  ])('rejects %s before querying the ledger', async (_name, query) => {
    const result = await invokeLedgerEntries(query);

    expect(result.statusCode).toBe(400);
    expect(result.responseBody).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'studentId 必须是非空字符串',
        field: 'studentId',
      },
    });
    expect(result.listEntries).not.toHaveBeenCalled();
  });
});
