import type {
  ObjectReference,
  PresentationAction,
} from '@teacher-platform/contracts';

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function getPresentationReferenceRoute(reference: ObjectReference): string | null {
  if (reference.type === 'Student') {
    return `/students/${encoded(reference.objectId)}`;
  }
  if (reference.type === 'Schedule') {
    return `/schedules?focus=${encoded(reference.objectId)}`;
  }
  if (reference.type === 'Lesson') {
    return reference.studentId
      ? `/students/${encoded(reference.studentId)}?tab=lessons&focus=${encoded(reference.objectId)}`
      : null;
  }
  if (reference.type === 'Payment') {
    return reference.studentId
      ? `/students/${encoded(reference.studentId)}?tab=payments&focus=${encoded(reference.objectId)}`
      : null;
  }
  if (reference.type === 'Memo') {
    return `/today?focusMemo=${encoded(reference.objectId)}`;
  }
  if (reference.type === 'ParentFeedback') {
    return `/feedback?focus=${encoded(reference.objectId)}`;
  }
  return null;
}

export function getPresentationActionRoute(
  action: PresentationAction,
  references: readonly ObjectReference[],
): string | null {
  if (action.kind !== 'open-reference') return null;
  const reference = references.find((item) => item.id === action.referenceId);
  return reference ? getPresentationReferenceRoute(reference) : null;
}
