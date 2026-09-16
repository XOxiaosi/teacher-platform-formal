import { Router } from 'express';
import { notFound, ok } from '@teacher-platform/contracts';
import type { StudentRecordsService, StudentSourceRecordService } from '../../features/student-records/index.js';
import { getTeacherId, sendResult, sendTeacherError } from './api-helpers.js';

export function createStudentRecordSourceRouter(dependencies: {
  records: StudentRecordsService;
  sources: StudentSourceRecordService;
}): Router {
  const router = Router();
  router.get('/students/:studentId/records/:recordId/source', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const record = await dependencies.records.getOwnedRecord({
      teacherId: teacher.value, recordId: req.params.recordId,
    });
    if (!record.ok) return sendResult(res, record);
    if (record.value.studentId !== req.params.studentId) return sendTeacherError(res, notFound('记录不存在'));
    const recordId = record.value.id;
    if (!record.value.sourceRecordId) return sendResult(res, ok({ recordId, state: 'none', source: null }));
    const source = await dependencies.sources.getOwnedSource({
      teacherId: teacher.value, sourceRecordId: record.value.sourceRecordId,
    });
    if (!source.ok) {
      if (source.error.code === 'NOT_FOUND') return sendResult(res, ok({ recordId, state: 'unavailable', source: null }));
      return sendResult(res, source);
    }
    const value = source.value;
    if (value.studentId && value.studentId !== record.value.studentId) {
      return sendResult(res, ok({ recordId, state: 'unavailable', source: null }));
    }
    const deleted = value.captureStatus === 'deleted';
    return sendResult(res, ok({
      recordId, state: deleted ? 'deleted' : value.rawText === null ? 'unavailable' : 'available',
      source: {
        id: value.id, sourceType: value.sourceType, captureStatus: value.captureStatus,
        rawText: deleted ? null : value.rawText,
        occurredAt: value.occurredAt, updatedAt: value.updatedAt,
      },
    }));
  });
  return router;
}
