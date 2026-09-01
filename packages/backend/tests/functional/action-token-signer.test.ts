import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionTokenSigner } from '../../src/features/pending-action/action-token-signer.js';

const SECRET = 'test-action-token-secret-with-at-least-32-bytes';

function signedToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

describe('ActionTokenSigner', () => {
  it('签名 token 只包含 version 与 pendingActionId，并可验证', () => {
    const signer = createActionTokenSigner({ secret: SECRET });

    const signed = signer.sign('pending-action-1');

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const [payload] = signed.value.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      version: 1,
      pendingActionId: 'pending-action-1',
    });
    expect(signer.verify(signed.value)).toEqual({
      ok: true,
      value: { pendingActionId: 'pending-action-1' },
    });
  });

  it('同一 pendingActionId 可稳定重建同一 token', () => {
    const signer = createActionTokenSigner({ secret: SECRET });

    expect(signer.sign('pending-action-1')).toEqual(signer.sign('pending-action-1'));
  });

  it.each([
    '',
    'only-one-part',
    'a.b.c',
    '%%%%.invalid',
    signedToken({ version: 2, pendingActionId: 'pending-action-1' }),
    signedToken({ version: 1, pendingActionId: '' }),
    signedToken({ version: 1, pendingActionId: 'pending-action-1', teacherId: 'leak' }),
  ])('拒绝畸形、未知版本或越界 payload：%s', (token) => {
    const signer = createActionTokenSigner({ secret: SECRET });

    expect(signer.verify(token)).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'actionToken 无效', field: 'actionToken' },
    });
  });

  it('拒绝同长度坏签名，且错误不泄露签名细节', () => {
    const signer = createActionTokenSigner({ secret: SECRET });
    const signed = signer.sign('pending-action-1');
    if (!signed.ok) throw new Error(signed.error.message);
    const [payload, signature] = signed.value.split('.');
    const replacement = signature.endsWith('A') ? 'B' : 'A';
    const tampered = `${payload}.${signature.slice(0, -1)}${replacement}`;

    expect(signer.verify(tampered)).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'actionToken 无效', field: 'actionToken' },
    });
  });

  it('拒绝非法 pendingActionId 和不足 32 bytes 的 secret', () => {
    const signer = createActionTokenSigner({ secret: SECRET });

    expect(signer.sign('')).toMatchObject({ ok: false, error: { field: 'pendingActionId' } });
    expect(() => createActionTokenSigner({ secret: 'too-short' })).toThrow('actionToken secret 至少需要 32 bytes');
  });

  it('实现使用 timingSafeEqual 比较签名', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/features/pending-action/action-token-signer.ts'),
      'utf8',
    );

    expect(source).toContain('timingSafeEqual');
  });
});
