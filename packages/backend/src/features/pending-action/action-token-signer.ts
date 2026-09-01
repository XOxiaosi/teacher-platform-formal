import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok, validationError } from '@teacher-platform/contracts';
import type {
  ActionTokenSigner,
  CreateActionTokenSignerOptions,
} from './types.js';

const TOKEN_VERSION = 1;
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 2048;
const MAX_ID_LENGTH = 128;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_LENGTH = 43;

function invalidToken() {
  return err(validationError('actionToken 无效', 'actionToken'));
}

function validPendingActionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodePayload(segment: string): { version: 1; pendingActionId: string } | null {
  if (!segment || !BASE64URL_PATTERN.test(segment)) return null;
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== 'pendingActionId' || keys[1] !== 'version') return null;
    if (record.version !== TOKEN_VERSION || !validPendingActionId(record.pendingActionId)) return null;
    return { version: TOKEN_VERSION, pendingActionId: record.pendingActionId };
  } catch {
    return null;
  }
}

export function createActionTokenSigner(options: CreateActionTokenSignerOptions): ActionTokenSigner {
  const secret = Buffer.isBuffer(options.secret)
    ? Buffer.from(options.secret)
    : Buffer.from(options.secret, 'utf8');
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new Error('actionToken secret 至少需要 32 bytes');
  }

  function signature(payloadSegment: string): Buffer {
    return createHmac('sha256', secret).update(payloadSegment).digest();
  }

  return {
    sign(pendingActionId) {
      if (!validPendingActionId(pendingActionId)) {
        return err(validationError('pendingActionId 无效', 'pendingActionId'));
      }
      const payload = Buffer.from(JSON.stringify({
        version: TOKEN_VERSION,
        pendingActionId,
      }), 'utf8').toString('base64url');
      return ok(`${payload}.${signature(payload).toString('base64url')}`);
    },

    verify(actionToken) {
      if (typeof actionToken !== 'string' || actionToken.length === 0 || actionToken.length > MAX_TOKEN_LENGTH) {
        return invalidToken();
      }
      const parts = actionToken.split('.');
      if (parts.length !== 2) return invalidToken();
      const [payloadSegment, signatureSegment] = parts;
      const payload = decodePayload(payloadSegment);
      if (!payload || signatureSegment.length !== SIGNATURE_LENGTH || !BASE64URL_PATTERN.test(signatureSegment)) {
        return invalidToken();
      }

      const actual = Buffer.from(signatureSegment, 'base64url');
      const expected = signature(payloadSegment);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return invalidToken();
      }
      return ok({ pendingActionId: payload.pendingActionId });
    },
  };
}
