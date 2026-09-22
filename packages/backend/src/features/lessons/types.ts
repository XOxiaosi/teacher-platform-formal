import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';
export type { LessonStatus } from './state-machine.js';

export interface CreateLessonInput {
  teacherId: string;
  studentId: string;
  scheduleId: string;
  date: Date;
  status?: import('./state-machine.js').LessonStatus;
}

export interface ListLessonsInput extends PaginationParams {
  teacherId: string;
  studentId?: string;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface ListLessonsInWindowInput {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
}

export interface GetOwnedLessonInput {
  teacherId: string;
  lessonId: string;
}

export interface ListLessonsForScheduleInput {
  teacherId: string;
  scheduleId: string;
}

export interface UpdateLessonInput {
  lessonId: string;
  progress?: string;
  studentState?: string;
  homework?: string;
  teacherNote?: string;
}

export interface LessonRecordChanges {
  progress?: string | null;
  studentState?: string | null;
  homework?: string | null;
  teacherNote?: string | null;
}

export interface UpdateLessonRecordOwnerInput {
  teacherId: string;
  lessonId: string;
  expectedUpdatedAt?: Date;
  changes: LessonRecordChanges;
}

export interface LessonRecordEdit {
  before: LessonData;
  after: LessonData;
}

export interface LessonRecordEditor {
  updateLessonRecord(
    input: UpdateLessonRecordOwnerInput,
  ): Promise<Result<LessonRecordEdit, CommonError>>;
}

export interface UpdateLessonStatusInput {
  lessonId: string;
  targetStatus: import('./state-machine.js').LessonStatus;
}

export interface CountByStudentInput {
  studentId: string;
  status?: string;
}

export interface LessonData {
  id: string;
  teacherId: string;
  studentId: string;
  scheduleId: string;
  date: Date;
  status: string;
  progress: string | null;
  studentState: string | null;
  homework: string | null;
  teacherNote: string | null;
  sourceNoteId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LessonService {
  createLesson(input: CreateLessonInput): Promise<Result<LessonData, CommonError>>;
  getLesson(lessonId: string): Promise<Result<LessonData, CommonError>>;
  getOwnedLesson(input: GetOwnedLessonInput): Promise<Result<LessonData, CommonError>>;
  listLessonsForSchedule(input: ListLessonsForScheduleInput): Promise<Result<LessonData[], CommonError>>;
  listLessons(input: ListLessonsInput): Promise<Result<{ items: LessonData[]; total: number }, CommonError>>;
  listLessonsInWindow(input: ListLessonsInWindowInput): Promise<Result<{ items: LessonData[]; total: number }, CommonError>>;
  updateLesson(input: UpdateLessonInput): Promise<Result<LessonData, CommonError>>;
  updateLessonStatus(input: UpdateLessonStatusInput): Promise<Result<LessonData, CommonError>>;
  countByStudent(input: CountByStudentInput): Promise<Result<number, CommonError>>;
}
