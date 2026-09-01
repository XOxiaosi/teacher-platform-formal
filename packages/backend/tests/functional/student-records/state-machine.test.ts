import { describe, it, expect } from 'vitest';
import { validateStudentRecordReviewTransition } from '../../../src/features/student-records/state-machine.js';

describe('validateStudentRecordReviewTransition', () => {
  it('candidate -> confirmed: 合法', () => {
    const result = validateStudentRecordReviewTransition('candidate', 'confirmed');
    expect(result.ok).toBe(true);
  });

  it('candidate -> rejected: 合法', () => {
    const result = validateStudentRecordReviewTransition('candidate', 'rejected');
    expect(result.ok).toBe(true);
  });

  it('confirmed -> rejected: 合法', () => {
    const result = validateStudentRecordReviewTransition('confirmed', 'rejected');
    expect(result.ok).toBe(true);
  });

  it('rejected -> confirmed: 合法', () => {
    const result = validateStudentRecordReviewTransition('rejected', 'confirmed');
    expect(result.ok).toBe(true);
  });

  it('superseded 为终态：superseded -> confirmed 非法', () => {
    const result = validateStudentRecordReviewTransition('superseded', 'confirmed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.field).toBe('reviewStatus');
  });

  it('superseded -> rejected 非法', () => {
    const result = validateStudentRecordReviewTransition('superseded', 'rejected');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('confirmed -> confirmed（无变化）非法', () => {
    const result = validateStudentRecordReviewTransition('confirmed', 'confirmed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('candidate -> superseded 非法', () => {
    const result = validateStudentRecordReviewTransition('candidate', 'superseded');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });

  it('未知来源状态非法', () => {
    const result = validateStudentRecordReviewTransition('bogus', 'confirmed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
