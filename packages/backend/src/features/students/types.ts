import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';
export type { StudentStatus } from './state-machine.js';

export interface CreateStudentInput {
  teacherId: string;
  name: string;
  grade: string;
  source?: string;
  stageGoal?: string;
}

export interface ListStudentsInput extends PaginationParams {
  teacherId: string;
  status?: string;
}

export interface ListOwnedStudentsByIdsInput {
  teacherId: string;
  studentIds: string[];
}

export interface GetOwnedStudentInput {
  teacherId: string;
  studentId: string;
}

export interface UpdateStudentInput {
  studentId: string;
  name?: string;
  grade?: string;
  source?: string;
  stageGoal?: string;
}

export interface StudentProfileChanges {
  name?: string;
  grade?: string;
  source?: string | null;
  stageGoal?: string | null;
}

export interface UpdateStudentProfileOwnerInput {
  teacherId: string;
  studentId: string;
  expectedUpdatedAt?: Date;
  changes: StudentProfileChanges;
}

export interface StudentProfileEdit {
  before: StudentData;
  after: StudentData;
}

export interface StudentProfileEditor {
  updateStudentProfile(
    input: UpdateStudentProfileOwnerInput,
  ): Promise<Result<StudentProfileEdit, CommonError>>;
}

export interface UpdateStudentStatusInput {
  studentId: string;
  targetStatus: import('./state-machine.js').StudentStatus;
}

export interface StudentData {
  id: string;
  teacherId: string;
  name: string;
  grade: string;
  source: string | null;
  currentStatus: string;
  stageGoal: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudentService {
  createStudent(input: CreateStudentInput): Promise<Result<StudentData, CommonError>>;
  getStudent(studentId: string): Promise<Result<StudentData, CommonError>>;
  getOwnedStudent(input: GetOwnedStudentInput): Promise<Result<StudentData, CommonError>>;
  listStudents(input: ListStudentsInput): Promise<Result<{ items: StudentData[]; total: number }, CommonError>>;
  listOwnedStudentsByIds(input: ListOwnedStudentsByIdsInput): Promise<Result<StudentData[], CommonError>>;
  updateStudent(input: UpdateStudentInput): Promise<Result<StudentData, CommonError>>;
  updateStudentStatus(input: UpdateStudentStatusInput): Promise<Result<StudentData, CommonError>>;
}