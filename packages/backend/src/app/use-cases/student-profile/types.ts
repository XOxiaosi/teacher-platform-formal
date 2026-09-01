import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { StudentData } from '../../../features/students/index.js';
import type { ScheduleData } from '../../../features/scheduling/index.js';
import type { LessonData } from '../../../features/lessons/index.js';

export interface StudentProfileInput {
  teacherId: string;
  studentId: string;
}

export interface LessonBalance {
  purchased: number;
  attended: number;
  remaining: number;
}

export interface StudentProfileView {
  student: StudentData;
  recentSchedules: ScheduleData[];
  lessonHistory: LessonData[];
  lessonBalance: LessonBalance;
}

export interface StudentProfileUseCase {
  execute(input: StudentProfileInput): Promise<Result<StudentProfileView, CommonError>>;
}

export type StudentProfileFactory = (
  prismaOrOptions: PrismaClient | { getClient: () => Promise<PrismaClient> },
) => StudentProfileUseCase;
