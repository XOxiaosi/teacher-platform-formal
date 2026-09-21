import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PaymentRouteDependencies } from '../../../src/app/composition/types.js';
import { createPaymentRouter } from '../../../src/app/routes/payments.routes.js';

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';
const DATE_ONLY = '2026-09-15';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function createDependencies() {
  const listPayments = vi.fn(async () => ({
    ok: true as const,
    value: { items: [], total: 0 },
  }));
  const dependencies = {
    payments: {
      listPayments,
      createPayment: vi.fn(),
    },
    ledger: {
      prepareAdjustment: vi.fn(),
      confirmAdjustment: vi.fn(),
      listEntries: vi.fn(),
    },
  } as unknown as PaymentRouteDependencies;
  return { dependencies, listPayments };
}

async function invokePayments(query: Record<string, unknown>) {
  const { dependencies, listPayments } = createDependencies();
  const router = createPaymentRouter(dependencies);
  const layer = (router.stack as RouteLayer[]).find((candidate) => (
    candidate.route?.path === '/payments' && candidate.route.methods.get
  ));
  if (!layer?.route) throw new Error('route not registered: GET /payments');

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
  return { statusCode, responseBody, listPayments };
}

function expectQueryError(
  result: Awaited<ReturnType<typeof invokePayments>>,
  field: string,
  message = '缴费查询参数不合法',
) {
  expect(result.statusCode).toBe(400);
  expect(result.responseBody).toEqual({
    ok: false,
    error: {
      code: 'VALIDATION_ERROR',
      message,
      field,
    },
  });
  expect(result.listPayments).not.toHaveBeenCalled();
}

describe('GET /payments query validation', () => {
  it('accepts omitted parameters and forwards the teacher plus undefined filters', async () => {
    const result = await invokePayments({});

    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toEqual({ ok: true, data: { items: [], total: 0 } });
    expect(result.listPayments).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      studentId: undefined,
      paidAtFrom: undefined,
      paidAtTo: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it.each([
    ['single value', { studentId: 'student-1' }, 'student-1'],
    ['trimmed value', { studentId: '  student-1  ' }, 'student-1'],
  ])('accepts %s studentId and forwards the canonical value', async (_name, query, studentId) => {
    const result = await invokePayments(query);

    expect(result.statusCode).toBe(200);
    expect(result.listPayments).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-1',
      studentId,
    }));
  });

  it.each([
    ['empty string', { studentId: '' }],
    ['whitespace only', { studentId: '   ' }],
    ['repeated values', { studentId: ['student-1', 'student-2'] }],
    ['number', { studentId: 1 }],
    ['object', { studentId: { id: 'student-1' } }],
    ['null', { studentId: null }],
  ])('rejects %s studentId before querying payments', async (_name, query) => {
    const result = await invokePayments(query);

    expectQueryError(result, 'studentId', 'studentId 必须是非空字符串');
  });

  it.each([
    ['from only', { paidAtFrom: FROM }, new Date(FROM), undefined],
    ['to only', { paidAtTo: TO }, undefined, new Date(TO)],
    ['both bounds', { paidAtFrom: FROM, paidAtTo: TO }, new Date(FROM), new Date(TO)],
    ['date-only bound', { paidAtFrom: DATE_ONLY }, new Date(`${DATE_ONLY}T00:00:00.000Z`), undefined],
    ['equal bounds', { paidAtFrom: FROM, paidAtTo: FROM }, new Date(FROM), new Date(FROM)],
  ])('accepts %s paidAt bounds and forwards Date values', async (_name, query, paidAtFrom, paidAtTo) => {
    const result = await invokePayments(query);

    expect(result.statusCode).toBe(200);
    expect(result.listPayments).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-1',
      paidAtFrom,
      paidAtTo,
    }));
  });

  it.each([
    ['empty from', { paidAtFrom: '' }],
    ['whitespace from', { paidAtFrom: '   ' }],
    ['invalid from', { paidAtFrom: 'not-a-date' }],
    ['impossible from calendar date', { paidAtFrom: '2026-02-30' }],
    ['non-leap-year February 29', { paidAtFrom: '2025-02-29' }],
    ['natural-language from', { paidAtFrom: 'September 1, 2026' }],
    ['timezone-less from timestamp', { paidAtFrom: '2026-09-01T00:00:00' }],
    ['repeated from', { paidAtFrom: [FROM, TO] }],
    ['number from', { paidAtFrom: 1 }],
    ['object from', { paidAtFrom: { value: FROM } }],
    ['null from', { paidAtFrom: null }],
    ['empty to', { paidAtTo: '' }],
    ['whitespace to', { paidAtTo: '   ' }],
    ['invalid to', { paidAtTo: 'not-a-date' }],
    ['repeated to', { paidAtTo: [FROM, TO] }],
    ['number to', { paidAtTo: 1 }],
    ['object to', { paidAtTo: { value: TO } }],
    ['null to', { paidAtTo: null }],
    ['inverted bounds', { paidAtFrom: TO, paidAtTo: FROM }],
  ])('rejects %s before querying payments', async (_name, query) => {
    const result = await invokePayments(query);

    expectQueryError(result, 'query');
  });

  it.each([
    ['page', { page: '2' }, { page: 2, pageSize: undefined }],
    ['pageSize', { pageSize: '50' }, { page: undefined, pageSize: 50 }],
    ['both', { page: '2', pageSize: '50' }, { page: 2, pageSize: 50 }],
  ])('accepts valid %s values and forwards numbers', async (_name, query, pagination) => {
    const result = await invokePayments(query);

    expect(result.statusCode).toBe(200);
    expect(result.listPayments).toHaveBeenCalledWith(expect.objectContaining({
      teacherId: 'teacher-1',
      ...pagination,
    }));
  });

  it.each([
    ['page zero', { page: '0' }],
    ['page negative', { page: '-1' }],
    ['page decimal', { page: '1.5' }],
    ['page exponent', { page: '1e2' }],
    ['page empty', { page: '' }],
    ['page whitespace', { page: '   ' }],
    ['page NaN text', { page: 'NaN' }],
    ['page array', { page: ['2'] }],
    ['page number', { page: 2 }],
    ['page object', { page: { value: '2' } }],
    ['page null', { page: null }],
    ['pageSize zero', { pageSize: '0' }],
    ['pageSize negative', { pageSize: '-1' }],
    ['pageSize decimal', { pageSize: '1.5' }],
    ['pageSize exponent', { pageSize: '1e2' }],
    ['pageSize empty', { pageSize: '' }],
    ['pageSize whitespace', { pageSize: '   ' }],
    ['pageSize NaN text', { pageSize: 'NaN' }],
    ['pageSize array', { pageSize: ['50'] }],
    ['pageSize number', { pageSize: 50 }],
    ['pageSize object', { pageSize: { value: '50' } }],
    ['pageSize null', { pageSize: null }],
  ])('rejects %s before querying payments', async (_name, query) => {
    const result = await invokePayments(query);

    expectQueryError(result, 'query');
  });
});
