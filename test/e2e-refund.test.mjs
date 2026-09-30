import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildRefundEvent,
  normalizeBaseUrl,
  signRefundBody,
} from '../scripts/e2e-refund.mjs';

test('E2E sender refuses the maintainer production backend', () => {
  assert.throws(
    () => normalizeBaseUrl('https://refundmanagement-production.up.railway.app'),
    /refusing to run E2E against the production backend/,
  );
});

test('E2E refund fixture builds the expected Roblox envelope', () => {
  const event = buildRefundEvent({
    notificationId: 'e2e-n-1',
    transactionId: 'e2e-tx-1',
    userId: 123,
    productId: 456,
    robuxAmount: 400,
    eventTime: '2026-09-30T00:00:00.000Z',
  });

  assert.equal(event.EventType, 'TransactionRefunded');
  assert.equal(event.EventPayload.UserId, 123);
  assert.equal(event.EventPayload.ProductId, 456);
  assert.equal(event.EventPayload.TransactionId, 'e2e-tx-1');
});

test('E2E sender signs timestamp dot exact raw JSON body with HMAC SHA256', () => {
  const body = buildRefundEvent({
    notificationId: 'e2e-n-2',
    transactionId: 'e2e-tx-2',
    userId: 123,
    productId: 456,
    eventTime: '2026-09-30T00:00:00.000Z',
  });

  const signed = signRefundBody({
    body,
    secret: 'e2e-secret',
    timestamp: '1790726400',
  });

  const expected = crypto
    .createHmac('sha256', 'e2e-secret')
    .update(`1790726400.${signed.rawBody}`, 'utf8')
    .digest('base64');

  assert.equal(signed.header, `t=1790726400,v1=${expected}`);
});
