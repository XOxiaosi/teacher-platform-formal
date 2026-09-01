import type { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createStudentService } from '../../../features/students/index.js';
import type { SortedStudentItem, StudentListSortedUseCase } from './types.js';

export function createStudentListSortedUseCase(prisma: PrismaClient): StudentListSortedUseCase {
  const students = createStudentService(prisma);
  const lessons = createLessonService(prisma);

  return {
    async execute(input) {
      const studentList = await students.listStudents({ teacherId: input.teacherId, pageSize: 1000 });
      if (!studentList.ok) return studentList;

      const items = await Promise.all(
        studentList.value.items.map(async (student) => ({
          student,
          lastLessonAt: await getLastLessonAt(lessons, input.teacherId, student.id),
        })),
      );

      return ok({ items: sortStudents(items) });
    },
  };
}

async function getLastLessonAt(
  lessons: ReturnType<typeof createLessonService>,
  teacherId: string,
  studentId: string,
): Promise<Date | null> {
  const result = await lessons.listLessons({ teacherId, studentId, pageSize: 1 });
  if (!result.ok || result.value.items.length === 0) return null;
  return result.value.items[0].date;
}

function sortStudents(items: SortedStudentItem[]): SortedStudentItem[] {
  return [...items].sort((a, b) => {
    const finished = compareFinished(a.student.currentStatus, b.student.currentStatus);
    if (finished !== 0) return finished;
    return compareDateDesc(a.lastLessonAt, b.lastLessonAt);
  });
}

function compareFinished(a: string, b: string): number {
  if (a === 'finished' && b !== 'finished') return 1;
  if (a !== 'finished' && b === 'finished') return -1;
  return 0;
}

function compareDateDesc(a: Date | null, b: Date | null): number {
  if (a && b) return b.getTime() - a.getTime();
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}
