import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { StudentData } from '../../../features/students/index.js';

export interface StudentListSortedInput {
  teacherId: string;
}

export interface SortedStudentItem {
  student: StudentData;
  lastLessonAt: Date | null;
}

export interface StudentListSortedView {
  items: SortedStudentItem[];
}

export interface StudentListSortedUseCase {
  execute(input: StudentListSortedInput): Promise<Result<StudentListSortedView, CommonError>>;
}

export type StudentListSortedFactory = (prisma: PrismaClient) => StudentListSortedUseCase;
