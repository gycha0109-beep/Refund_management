import crypto from 'node:crypto';

export function verifyApiKey({ provided, expected }) {
  if (!expected) return { ok: false, reason: 'api_key_not_configured' };
  if (!provided || typeof provided !== 'string') {
    return { ok: false, reason: 'missing_api_key' };
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return { ok: false, reason: 'api_key_mismatch' };
  }

  const ok = crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  return ok ? { ok: true } : { ok: false, reason: 'api_key_mismatch' };
}
