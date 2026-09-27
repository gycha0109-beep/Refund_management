import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpectedSignature,
  isRefundEvent,
  parseRobloxSignature,
  validateEnvelope,
  verifyRobloxWebhook,
} from '../src/webhook.mjs';

test('parses Roblox signature header', () => {
  assert.deepEqual(parseRobloxSignature('t=123,v1=abc'), { timestamp: '123', signature: 'abc' });
  assert.equal(parseRobloxSignature('t=123'), null);
});

test('verifies a valid webhook signature', () => {
  const body = {
    NotificationId: 'n-1',
    EventType: 'TransactionRefunded',
    EventTime: '2026-09-27T04:00:00Z',
    EventPayload: { UserId: 123 },
  };
  const secret = 'test-secret';
  const timestamp = '1790481600';
  const signature = buildExpectedSignature({ timestamp, body, secret });
  const result = verifyRobloxWebhook({
    header: `t=${timestamp},v1=${signature}`,
    body,
    secret,
    nowMs: Number(timestamp) * 1000,
  });
  assert.deepEqual(result, { ok: true });
});

test('rejects stale webhook requests', () => {
  const body = {
    NotificationId: 'n-2',
    EventType: 'TransactionRefunded',
    EventTime: '2026-09-27T04:00:00Z',
    EventPayload: {},
  };
  const secret = 'test-secret';
  const timestamp = '1000';
  const signature = buildExpectedSignature({ timestamp, body, secret });
  const result = verifyRobloxWebhook({
    header: `t=${timestamp},v1=${signature}`,
    body,
    secret,
    nowMs: 2_000_000,
    maxAgeSeconds: 60,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired_request');
});

test('recognizes refund events and validates envelopes', () => {
  const refund = {
    NotificationId: 'n-3',
    EventType: 'TransactionRefunded',
    EventTime: '2026-09-27T04:00:00Z',
    EventPayload: { ProductId: 42 },
  };
  assert.equal(validateEnvelope(refund), true);
  assert.equal(isRefundEvent(refund), true);
  assert.equal(isRefundEvent({ EventType: 'SampleNotification' }), false);
});
