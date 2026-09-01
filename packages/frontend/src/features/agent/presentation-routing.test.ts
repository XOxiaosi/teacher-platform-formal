import { describe, expect, it } from 'vitest';
import type { ObjectReference, PresentationAction } from '@teacher-platform/contracts';
import {
  getPresentationActionRoute,
  getPresentationReferenceRoute,
} from './presentation-routing';

const reference = (
  type: ObjectReference['type'],
  objectId: string,
  studentId?: string,
): ObjectReference => ({
  id: `${type}:${objectId}`,
  type,
  objectId,
  label: objectId,
  ...(studentId ? { studentId } : {}),
});

describe('presentation routing', () => {
  it.each([
    [reference('Student', 'student/1'), '/students/student%2F1'],
    [reference('Schedule', 'schedule/1'), '/schedules?focus=schedule%2F1'],
    [reference('Lesson', 'lesson/1', 'student/1'), '/students/student%2F1?tab=lessons&focus=lesson%2F1'],
    [reference('Payment', 'payment/1', 'student/1'), '/students/student%2F1?tab=payments&focus=payment%2F1'],
    [reference('Memo', 'memo/1'), '/today?focusMemo=memo%2F1'],
    [reference('ParentFeedback', 'feedback/1'), '/feedback?focus=feedback%2F1'],
  ] as const)('为%s生成受控编码route', (input, expected) => {
    expect(getPresentationReferenceRoute(input)).toBe(expected);
  });

  it('Lesson和Payment缺studentId时fail-closed', () => {
    expect(getPresentationReferenceRoute(reference('Lesson', 'lesson-1'))).toBeNull();
    expect(getPresentationReferenceRoute(reference('Payment', 'payment-1'))).toBeNull();
  });

  it('action只解析同一文档内存在的reference', () => {
    const references = [reference('Student', 'student-1')];
    const action: PresentationAction = {
      id: 'open-student',
      kind: 'open-reference',
      label: '查看学生',
      referenceId: references[0].id,
    };

    expect(getPresentationActionRoute(action, references)).toBe('/students/student-1');
    expect(getPresentationActionRoute({ ...action, referenceId: 'missing' }, references)).toBeNull();
  });
});
