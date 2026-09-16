import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createCaptureRouter } from '../../src/app/routes/capture.routes.js';
import type { CaptureService } from '../../src/features/capture/index.js';

const CAPTURE = {
  id: 'cap-1', sourceType: 'text' as const, sourceChannel: 'web' as const, rawText: '课前小测',
  occurredAt: new Date('2030-01-01T00:00:00.000Z'), createdAt: new Date('2030-01-01T00:00:00.000Z'),
  confirmedRecordId: null,
  task: { id: 'task-1', status: 'completed', processorVersion: 'text-verbatim-v1' },
  candidate: { id: 'candidate-1', candidateType: 'verbatim_note' as const, payload: { text: '课前小测' }, reviewStatus: 'pending' as const, confidence: null, confirmedRecordId: null, version: 1, originalPayload: { text: '课前小测' } },
};
const captureView = { ...CAPTURE, candidates: [CAPTURE.candidate] };
function app(capture: CaptureService) {
  const instance = express(); instance.use(express.json());
  instance.use((req, _res, next) => { (req as typeof req & { teacherId?: string }).teacherId = 'teacher-a'; next(); });
  instance.use(createCaptureRouter({ capture })); return instance;
}
function fake(): CaptureService {
  return {
    list: vi.fn(async () => ({ ok: true, value: { items: [captureView], nextCursor: null } })),
    editCandidate: vi.fn(async () => ({ ok: true, value: captureView })),
    reviewCandidate: vi.fn(async () => ({ ok: true, value: captureView })),
    confirmRecord: vi.fn(async () => ({ ok: true, value: { eventId: 'cap-1', candidateId: 'candidate-1', recordId: 'record-1', studentId: 'student-1', scheduleId: null, category: 'general_note' as const, replayed: false } })),
    createText: vi.fn(async () => ({ ok: true, value: { capture: captureView, replayed: false } })),
    get: vi.fn(async () => ({ ok: true, value: captureView })),
    requestDeletion: vi.fn(async () => ({ ok: true, value: { receipt: { id: 'receipt-1', eventId: 'cap-1', status: 'completed', attemptCount: 1, retryable: false, lastErrorCode: null, createdAt: new Date(), completedAt: new Date() }, replayed: false } })),
    getDeletionReceipt: vi.fn(async () => ({ ok: true, value: { id: 'receipt-1', eventId: 'cap-1', status: 'completed', attemptCount: 1, retryable: false, lastErrorCode: null, createdAt: new Date(), completedAt: new Date() } })),
    retryDeletion: vi.fn(async () => ({ ok: true, value: { receipt: { id: 'receipt-1', eventId: 'cap-1', status: 'completed', attemptCount: 1, retryable: false, lastErrorCode: null, createdAt: new Date(), completedAt: new Date() }, replayed: true } })),
  };
}

describe('T-015 and A04 capture API contract', () => {
  it('text creates 201 and forwards only authenticated teacher identity', async () => {
    const service = fake();
    const response = await request(app(service)).post('/captures').set('x-teacher-id', 'teacher-attacker').send({ clientRequestId: 'capture-0001', sourceType: 'text', text: '课前小测' });
    expect(response.status).toBe(201); expect(response.body.data.capture.rawText).toBe('课前小测');
    expect(service.createText).toHaveBeenCalledWith({ teacherId: 'teacher-a', clientRequestId: 'capture-0001', text: '课前小测' });
  });
  it('image/audio are stably rejected before calling the service', async () => {
    const service = fake();
    const response = await request(app(service)).post('/captures').send({ clientRequestId: 'capture-0001', sourceType: 'image', text: 'x' });
    expect(response.status).toBe(400); expect(response.body.error).toEqual({ code: 'VALIDATION_ERROR', message: '当前仅支持网页文字记录', field: 'sourceType' });
    expect(service.createText).not.toHaveBeenCalled();
  });
  it('deletion endpoint returns 202 and retry replay returns 200', async () => {
    const service = fake(); const instance = app(service);
    expect((await request(instance).post('/captures/cap-1/deletions').send({ clientRequestId: 'delete-0001' })).status).toBe(202);
    expect((await request(instance).post('/capture-deletions/receipt-1/retry').send({})).status).toBe(200);
  });
});

describe('A04 candidate review API', () => {
  it('uses authenticated identity and explicit candidate versions for each action', async () => {
    const service = fake(); const instance = app(service);
    expect((await request(instance).get('/captures?limit=1')).body.data.items).toHaveLength(1);
    expect((await request(instance).patch('/captures/cap-1/candidates/candidate-1').send({ teacherId: 'attacker', version: 2, text: '更正' })).status).toBe(200);
    expect(service.editCandidate).toHaveBeenCalledWith({ teacherId: 'teacher-a', eventId: 'cap-1', candidateId: 'candidate-1', version: 2, text: '更正' });
    expect((await request(instance).post('/captures/cap-1/candidates/candidate-1/review').send({ version: 3, action: 'defer' })).status).toBe(200);
    expect(service.reviewCandidate).toHaveBeenCalledWith({ teacherId: 'teacher-a', eventId: 'cap-1', candidateId: 'candidate-1', version: 3, action: 'defer' });
    expect((await request(instance).post('/captures/cap-1/candidates/candidate-1/confirm-record').send({ version: 4, studentId: 'student-1', clientRequestId: 'confirm-0001' })).status).toBe(201);
    expect(service.confirmRecord).toHaveBeenCalledWith({ teacherId: 'teacher-a', eventId: 'cap-1', candidateId: 'candidate-1', version: 4, studentId: 'student-1', clientRequestId: 'confirm-0001', scheduleId: undefined });
  });
  it('missing versions and unsupported actions are rejected before a write service call', async () => {
    const service = fake(); const instance = app(service);
    expect((await request(instance).patch('/captures/cap-1/candidates/candidate-1').send({ text: '更正' })).status).toBe(400);
    expect((await request(instance).post('/captures/cap-1/candidates/candidate-1/review').send({ version: 1, action: 'confirm-all' })).status).toBe(400);
    expect((await request(instance).post('/captures/cap-1/candidates/candidate-1/confirm-record').send({ studentId: 'student-1', clientRequestId: 'confirm-0001' })).status).toBe(400);
    expect(service.editCandidate).not.toHaveBeenCalled(); expect(service.reviewCandidate).not.toHaveBeenCalled(); expect(service.confirmRecord).not.toHaveBeenCalled();
  });
  it('manual candidate inputs are narrowed to explicit text and are not allowed for media', async () => {
    const service = fake(); const instance = app(service);
    expect((await request(instance).post('/captures').send({ clientRequestId: 'capture-0001', sourceType: 'text', text: '原文', candidates: [{ text: '片段', teacherId: 'attacker' }] })).status).toBe(201);
    expect(service.createText).toHaveBeenCalledWith({ teacherId: 'teacher-a', clientRequestId: 'capture-0001', text: '原文', candidates: [{ text: '片段' }] });
    expect((await request(instance).post('/captures').send({ clientRequestId: 'capture-0001', sourceType: 'text', text: '原文', candidates: [] })).status).toBe(400);
  });
});
