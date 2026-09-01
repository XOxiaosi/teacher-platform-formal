import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contractTypes = readFileSync(resolve(__dirname, '../../../contracts/src/types.ts'), 'utf8');
const apiHelpers = readFileSync(resolve(__dirname, '../../src/app/routes/api-helpers.ts'), 'utf8');

describe('P5.2 重复消费错误协议红灯', () => {
  it('CommonErrorCode 声明 ALREADY_CONSUMED，并提供统一构造器', () => {
    expect(contractTypes).toContain("| 'ALREADY_CONSUMED'");
    expect(contractTypes).toMatch(/alreadyConsumed\s*=\s*\(message:\s*string\):\s*CommonError/);
    expect(contractTypes).toContain("code: 'ALREADY_CONSUMED'");
  });

  it('API 将 ALREADY_CONSUMED 稳定映射为 HTTP 409', () => {
    expect(apiHelpers).toMatch(/error\.code\s*===\s*['"]ALREADY_CONSUMED['"]\)\s*return\s+409/);
  });
});
