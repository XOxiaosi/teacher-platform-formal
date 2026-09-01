import { describe, expect, it } from 'vitest';
import type { ObjectReference, PresentationAction } from '@teacher-platform/contracts';

interface RoutingModule {
  getPresentationReferenceRoute?: (reference: ObjectReference) => string | null;
  getPresentationActionRoute?: (
    action: PresentationAction,
    references: readonly ObjectReference[],
  ) => string | null;
}

function reference(
  type: ObjectReference['type'],
  objectId: string,
  studentId?: string,
): ObjectReference {
  return {
    id: `${type}:${objectId}`,
    type,
    objectId,
    label: objectId,
    ...(studentId ? { studentId } : {}),
  };
}

async function loadRouting(): Promise<Required<RoutingModule> | undefined> {
  let module: RoutingModule = {};
  try {
    const modulePath = './object-reference-routing';
    module = await import(/* @vite-ignore */ modulePath) as unknown as RoutingModule;
  } catch {
    module = {};
  }
  expect(module).toMatchObject({
    getPresentationReferenceRoute: expect.any(Function),
    getPresentationActionRoute: expect.any(Function),
  });
  if (!module.getPresentationReferenceRoute || !module.getPresentationActionRoute) return undefined;
  return module as Required<RoutingModule>;
}

describe('shared controlled object-reference routing', () => {
  it('只把六种白名单对象映射为编码后的内部route', async () => {
    const routing = await loadRouting();
    if (!routing) return;

    expect([
      reference('Student', 'student/1'),
      reference('Schedule', 'schedule/1'),
      reference('Lesson', 'lesson/1', 'student/1'),
      reference('Payment', 'payment/1', 'student/1'),
      reference('Memo', 'memo/1'),
      reference('ParentFeedback', 'feedback/1'),
    ].map(routing.getPresentationReferenceRoute)).toEqual([
      '/students/student%2F1',
      '/schedules?focus=schedule%2F1',
      '/students/student%2F1?tab=lessons&focus=lesson%2F1',
      '/students/student%2F1?tab=payments&focus=payment%2F1',
      '/today?focusMemo=memo%2F1',
      '/feedback?focus=feedback%2F1',
    ]);
  });

  it('Lesson/Payment缺studentId及运行时未知对象类型均fail-closed', async () => {
    const routing = await loadRouting();
    if (!routing) return;
    const unknown = { ...reference('Student', 'student-1'), type: 'UnsafeUrl' } as unknown as ObjectReference;

    expect(routing.getPresentationReferenceRoute(reference('Lesson', 'lesson-1'))).toBeNull();
    expect(routing.getPresentationReferenceRoute(reference('Payment', 'payment-1'))).toBeNull();
    expect(routing.getPresentationReferenceRoute(unknown)).toBeNull();
  });

  it('action只解析同一调用边界内闭合的open-reference', async () => {
    const routing = await loadRouting();
    if (!routing) return;
    const references = [reference('Student', 'student-1')];
    const action: PresentationAction = {
      id: 'open-student',
      kind: 'open-reference',
      label: '查看学生',
      referenceId: references[0]!.id,
    };
    const unknownAction = { ...action, kind: 'unsafe-url' } as unknown as PresentationAction;

    expect(routing.getPresentationActionRoute(action, references)).toBe('/students/student-1');
    expect(routing.getPresentationActionRoute({ ...action, referenceId: 'missing' }, references)).toBeNull();
    expect(routing.getPresentationActionRoute(unknownAction, references)).toBeNull();
  });
});
