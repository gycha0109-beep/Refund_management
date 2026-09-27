import crypto from 'node:crypto';

export function parseRobloxSignature(header) {
  if (!header || typeof header !== 'string') return null;
  const parts = header.split(',').map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith('t='));
  const signaturePart = parts.find((part) => part.startsWith('v1='));
  if (!timestampPart || !signaturePart) return null;

  const timestamp = timestampPart.slice(2);
  const signature = signaturePart.slice(3);
  if (!/^\d+$/.test(timestamp) || !signature) return null;
  return { timestamp, signature };
}

export function buildExpectedSignature({ timestamp, body, secret }) {
  const message = `${timestamp}.${JSON.stringify(body)}`;
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

export function verifyRobloxWebhook({ header, body, secret, nowMs = Date.now(), maxAgeSeconds = 600 }) {
  if (!secret) return { ok: false, reason: 'missing_server_secret' };
  const parsed = parseRobloxSignature(header);
  if (!parsed) return { ok: false, reason: 'invalid_signature_header' };

  const requestTimeMs = Number(parsed.timestamp) * 1000;
  if (!Number.isFinite(requestTimeMs)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowMs - requestTimeMs) > maxAgeSeconds * 1000) {
    return { ok: false, reason: 'expired_request' };
  }

  const expected = buildExpectedSignature({ timestamp: parsed.timestamp, body, secret });
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parsed.signature);
  if (expectedBuffer.length !== actualBuffer.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const ok = crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export function isRefundEvent(event) {
  return typeof event?.EventType === 'string' && event.EventType.toLowerCase().includes('refund');
}

export function validateEnvelope(event) {
  if (!event || typeof event !== 'object') return false;
  return typeof event.NotificationId === 'string'
    && typeof event.EventType === 'string'
    && typeof event.EventTime === 'string'
    && event.EventPayload
    && typeof event.EventPayload === 'object';
}
