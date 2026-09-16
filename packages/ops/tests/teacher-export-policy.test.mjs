import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { BUSINESS_TABLES, EXPORT_POLICY, SHARED_DB_TABLES, TEACHER_DB_TABLES, validateExportPolicy, exportModelPolicy, assertExportTeacherId } from '../lib/teacher-export-policy.mjs';
const models = Prisma.dmmf.datamodel.models;

test('48 models: 37 tenant tables + 6 shared tables + public account + 4 excluded models', () => {
  assert.equal(validateExportPolicy(), true);
  assert.equal(models.length, 48);
  assert.equal(TEACHER_DB_TABLES.length, 37);
  assert.equal(SHARED_DB_TABLES.length, 6);
  assert.equal(BUSINESS_TABLES.length, 43);
  assert.deepEqual(Object.keys(EXPORT_POLICY).filter(name => EXPORT_POLICY[name].source === 'excluded').sort(), ['AdminAccount', 'AdminAuditLog', 'SessionStore', 'TeacherInvitation']);
  for (const name of BUSINESS_TABLES) assert.ok(EXPORT_POLICY[name].fields.includes('teacherId'));
});
test('unknown/new/removed model or field cannot silently enter or disappear from export', () => {
  assert.throws(() => validateExportPolicy([...models, { name: 'NewTeacherData', fields: [] }]), /SAFETY_BLOCK/);
  assert.throws(() => validateExportPolicy(models.slice(1)), /SAFETY_BLOCK/);
  for (const change of ['add', 'remove']) {
    const changed = structuredClone(models);
    if (change === 'add') changed[0].fields.push({ name: 'unknownCredential', kind: 'scalar' });
    else changed[0].fields.pop();
    assert.throws(() => validateExportPolicy(changed), /SAFETY_BLOCK/);
  }
  const duplicate = structuredClone(EXPORT_POLICY);
  duplicate.Student.fields.push('id');
  assert.throws(() => validateExportPolicy(models, duplicate), /SAFETY_BLOCK/);
});
test('credentials and worker authority tokens are explicitly excluded, including encrypted provider keys', () => {
  for (const [name, field] of [['TeacherRegistry', 'passwordHash'], ['ProviderConfig', 'apiKeyEnc'], ['TaskRuntime', 'leaseToken'], ['CaptureDeletionReceipt', 'claimToken']]) {
    assert.ok(EXPORT_POLICY[name].exclude.includes(field));
    const changed = structuredClone(EXPORT_POLICY);
    changed[name].exclude = changed[name].exclude.filter(value => value !== field);
    changed[name].fields.push(field);
    assert.throws(() => validateExportPolicy(models, changed), /credential/);
  }
  for (const name of ['SessionStore', 'TeacherInvitation', 'AdminAccount', 'AdminAuditLog', 'TeacherRegistry', 'Unknown', '__proto__']) assert.throws(() => exportModelPolicy(name), /SAFETY_BLOCK/);
  for (const owner of [undefined, null, '', 't/../other', 'x\ny']) assert.throws(() => assertExportTeacherId(owner), /SAFETY_BLOCK/);
});
