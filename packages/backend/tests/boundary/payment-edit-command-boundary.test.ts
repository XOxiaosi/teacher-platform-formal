import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../../src');

function read(relativePath: string): string {
  try {
    return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

describe('Payment edit command static boundaries', () => {
  it('production factory使用raw transaction、数据库clock、显式ChangeLog和sentinel回滚', () => {
    const source = read('app/use-cases/update-payment/index.ts');

    expect(source).toContain('rawPrisma.$transaction');
    expect(source).toContain('createDatabaseTrustedClock');
    expect(source).toContain('createChangelogService');
    expect(source).toMatch(/if \(!result\.ok\) throw new \w+Rollback/);
    expect(source).toContain('createPaymentEditor');
  });

  it('owner只使用teacher+id+updatedAt的updateMany CAS并禁止关系字段进入data', () => {
    const source = read('features/payments/payment-editor.ts');
    const updateData = source.slice(
      source.indexOf('function buildUpdateData'),
      source.indexOf('function toPaymentData'),
    );

    expect(source).toContain('prisma.payment.updateMany');
    expect(source).toMatch(/where:\s*\{[\s\S]*id: input\.paymentId,[\s\S]*teacherId: input\.teacherId,[\s\S]*updatedAtTs: before\.updatedAtTs/);
    expect(source).not.toContain('prisma.payment.update({');
    expect(source).not.toMatch(/data:\s*input\.changes/);
    expect(source).not.toMatch(/data:\s*\{\s*\.\.\.input\.changes/);
    expect(updateData).not.toContain('studentId');
  });

  it('纯应用use-case不import Prisma、不直接写数据库、不接受通用patch或caller snapshot', () => {
    const source = read('app/use-cases/update-payment/update-payment-use-case.ts');

    expect(source).not.toContain('@prisma/client');
    expect(source).not.toMatch(/prisma\.[A-Za-z]/);
    expect(source).not.toMatch(/updateAnything|tableName|modelName|fieldPath|JSON Patch/i);
    expect(source).not.toMatch(/recordChange\([^)]*command\.before/);
    expect(source).not.toMatch(/recordChange\([^)]*command\.after/);
  });

  it('legacy updatePayment保持原按ID写法，typed command位于独立owner', () => {
    const legacy = read('features/payments/payment-service.ts');
    const index = read('features/payments/index.ts');

    expect(legacy).toContain('async updatePayment(input: UpdatePaymentInput)');
    expect(legacy).toContain('where: { id: input.paymentId }');
    expect(index).toContain("export { createPaymentService } from './payment-service.js'");
    expect(index).toContain("export { createPaymentEditor } from './payment-editor.js'");
  });
});
