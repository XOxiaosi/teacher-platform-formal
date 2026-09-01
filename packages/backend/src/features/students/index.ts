export { createStudentService } from './student-service.js';
export { createStudentProfileEditor } from './student-profile-editor.js';
export { validateStudentTransition } from './state-machine.js';
export {
  normalizeStudentName,
  resolveStudentByName,
} from './student-name-resolver.js';
export type {
  NamedStudent,
  ResolveStudentByNameOptions,
  StudentNameResolution,
} from './student-name-resolver.js';
export type { CreateStudentProfileEditorOptions } from './student-profile-editor.js';
export type {
  StudentService,
  StudentProfileEditor,
  StudentProfileChanges,
  StudentProfileEdit,
  CreateStudentInput,
  GetOwnedStudentInput,
  ListStudentsInput,
  UpdateStudentInput,
  UpdateStudentProfileOwnerInput,
  UpdateStudentStatusInput,
  StudentData,
  StudentStatus,
} from './types.js';