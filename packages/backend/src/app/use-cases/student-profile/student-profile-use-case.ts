import type { PrismaClient } from '@prisma/client';
import { err, notFound, ok } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createLessonLedgerService } from '../../../features/payments/index.js';
import { createScheduleService } from '../../../features/scheduling/index.js';
import { createStudentService } from '../../../features/students/index.js';
import type { StudentProfileUseCase } from './types.js';

/**
 * S2 平移：工厂签名从 createStudentProfileUseCase(prisma) 扩展为
 * createStudentProfileUseCase(prisma | { getClient })——向后兼容。
 * getClient 请求期解析（数据库路由），未配置时回退装配期 client。
 * 内部组合的 schedule/lesson/ledger 服务仍按「解析出的 client」装配（S3 逐组平移）。
 */
export interface StudentProfileUseCaseOptions {
  getClient: () => Promise<PrismaClient>;
}

function isStudentProfileUseCaseOptions(
  value: PrismaClient | StudentProfileUseCaseOptions,
): value is StudentProfileUseCaseOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StudentProfileUseCaseOptions).getClient === 'function';
}

export function createStudentProfileUseCase(
  prismaOrOptions: PrismaClient | StudentProfileUseCaseOptions,
): StudentProfileUseCase {
  const getClient = isStudentProfileUseCaseOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;

  return {
    async execute(input) {
      const prisma = await getClient();
      const students = createStudentService(prisma);
      const schedules = createScheduleService(prisma);
      const lessons = createLessonService(prisma);
      const ledger = createLessonLedgerService(prisma);

      const student = await students.getStudent(input.studentId);
      if (!student.ok) return student;
      if (student.value.teacherId !== input.teacherId) {
        return err(notFound('学生不存在'));
      }

      const [recentSchedules, lessonHistory, lessonBalance] = await Promise.all([
        schedules.listSchedules({ teacherId: input.teacherId, studentId: input.studentId, pageSize: 5 }),
        lessons.listLessons({ teacherId: input.teacherId, studentId: input.studentId, pageSize: 20 }),
        ledger.calculateBalance({ teacherId: input.teacherId, studentId: input.studentId }),
      ]);

      if (!recentSchedules.ok) return recentSchedules;
      if (!lessonHistory.ok) return lessonHistory;
      if (!lessonBalance.ok) return lessonBalance;

      return ok({
        student: student.value,
        recentSchedules: recentSchedules.value.items,
        lessonHistory: lessonHistory.value.items,
        lessonBalance: lessonBalance.value,
      });
    },
  };
}
