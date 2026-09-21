/** Synthetic rows only. Uses the real Prisma schema and relations, without
 * borrowing any local database, media, field key, or provider credential. */
import { Prisma } from '@prisma/client';
import { BUSINESS_TABLES, EXPORT_POLICY } from '../../lib/teacher-export-policy.mjs';

export const modelId = (model, teacher) => `${teacher}_${model}`;
const models = Prisma.dmmf.datamodel.models;
const ORDER = [
  'Student', 'Conversation', 'CaptureEvent', 'CaptureTask', 'CaptureCandidate', 'CaptureDeletionReceipt',
  'TaskRuntime', 'AgentExecution', 'ConversationTurn', 'StepReceipt', 'PendingAction',
  'RecurrenceRule', 'RecurrenceRuleParticipant', 'Schedule', 'ScheduleParticipant', 'ScheduleRevision',
  'Lesson', 'Payment', 'LessonLedgerAdjustmentConfirmation', 'LessonLedgerEntry', 'ScheduleCompletionSnapshot',
  'StudentSourceRecord', 'StudentRecord', 'AssessmentDetail', 'CommunicationDetail',
  'ParentFeedback', 'FeedbackDraftTask', 'FeedbackDraftAttempt', 'FeedbackContextSnapshot', 'FeedbackEvidence',
];
const SECRET = new Set(['passwordHash', 'tokenHash', 'apiKeyEnc', 'claimToken', 'leaseToken']);
export function syntheticRow(modelName, teacher) {
  const model = models.find(item => item.name === modelName);
  const row = {};
  for (const field of model.fields.filter(item => item.kind !== 'object')) {
    if (field.name === 'id') row.id = modelId(modelName, teacher);
    else if (field.name === 'teacherId') row.teacherId = teacher;
    else if (SECRET.has(field.name)) row[field.name] = `SECRET_${teacher}_${field.name}`;
    else if (field.type === 'DateTime') row[field.name] = new Date('2026-01-05T00:00:00Z');
    else if (field.type === 'Int') row[field.name] = 1;
    else if (field.type === 'Float') row[field.name] = 1.5;
    else if (field.type === 'Boolean') row[field.name] = true;
    else if (field.type === 'Json') row[field.name] = { marker: `${teacher}_${modelName}_${field.name}` };
    else row[field.name] = `${teacher}_${modelName}_${field.name}`;
  }
  for (const relation of model.fields.filter(item => item.relationFromFields?.length)) {
    for (const field of relation.relationFromFields) {
      row[field] = relation.type === 'TeacherRegistry' ? teacher : relation.type === modelName ? null : modelId(relation.type, teacher);
    }
  }
  if (modelName === 'MediaAsset') row.originalPath = `media/${teacher}/synthetic/original`;
  if (modelName === 'ProviderConfig') row.baseUrl = 'https://synthetic.invalid/v1';
  if (modelName === 'CaptureCandidate') row.confirmedRecordId = modelId('StudentRecord', teacher);
  return row;
}
export async function seedBusiness(prisma, teachers, source) {
  const names = [...ORDER, ...BUSINESS_TABLES.filter(name => !ORDER.includes(name))]
    .filter(name => source === 'all' || EXPORT_POLICY[name].source === source);
  for (const teacher of teachers) {
    for (const name of names) {
      const delegate = name[0].toLowerCase() + name.slice(1);
      await prisma[delegate].create({ data: syntheticRow(name, teacher) });
    }
  }
}
export async function seedExcluded(prisma, teachers) {
  for (const teacher of teachers) {
    for (const name of ['SessionStore', 'TeacherInvitation', 'AdminAccount', 'AdminAuditLog']) {
      await prisma[name[0].toLowerCase() + name.slice(1)].create({ data: syntheticRow(name, teacher) });
    }
  }
}
export async function removeSyntheticRows(prisma, teachers) {
  const names = [...ORDER, ...BUSINESS_TABLES.filter(name => !ORDER.includes(name))].reverse();
  for (const name of names) await prisma[name[0].toLowerCase() + name.slice(1)].deleteMany({ where: { teacherId: { in: teachers } } });
  for (const name of ['SessionStore', 'TeacherInvitation', 'AdminAccount', 'AdminAuditLog']) {
    await prisma[name[0].toLowerCase() + name.slice(1)].deleteMany({ where: { id: { in: teachers.map(teacher => modelId(name, teacher)) } } });
  }
  await prisma.teacherRegistry.deleteMany({ where: { id: { in: teachers } } });
}
