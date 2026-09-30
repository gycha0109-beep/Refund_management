import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveActionLogPath, resolveRefundLogPath } from '../src/storage.mjs';

test('uses Railway volume automatically when attached', () => {
  const env = {
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
  };
  const refundStorage = resolveRefundLogPath(env);
  const actionStorage = resolveActionLogPath(env);

  assert.equal(refundStorage.logPath, path.resolve('/data/refunds.jsonl'));
  assert.equal(refundStorage.mode, 'railway-volume');
  assert.equal(refundStorage.persistent, true);

  assert.equal(actionStorage.logPath, path.resolve('/data/actions.jsonl'));
  assert.equal(actionStorage.mode, 'railway-volume');
  assert.equal(actionStorage.persistent, true);
});

test('falls back to ephemeral local storage without a volume', () => {
  const refundStorage = resolveRefundLogPath({});
  const actionStorage = resolveActionLogPath({});

  assert.equal(refundStorage.logPath, path.resolve('./data/refunds.jsonl'));
  assert.equal(refundStorage.mode, 'ephemeral');
  assert.equal(refundStorage.persistent, false);

  assert.equal(actionStorage.logPath, path.resolve('./data/actions.jsonl'));
  assert.equal(actionStorage.mode, 'ephemeral');
  assert.equal(actionStorage.persistent, false);
});

test('explicit paths override automatic volume paths', () => {
  const env = {
    REFUND_LOG_PATH: '/custom/refunds.jsonl',
    ACTION_LOG_PATH: '/custom/pro-actions.jsonl',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
  };
  const refundStorage = resolveRefundLogPath(env);
  const actionStorage = resolveActionLogPath(env);

  assert.equal(refundStorage.logPath, path.resolve('/custom/refunds.jsonl'));
  assert.equal(refundStorage.mode, 'explicit');
  assert.equal(refundStorage.persistent, false);

  assert.equal(actionStorage.logPath, path.resolve('/custom/pro-actions.jsonl'));
  assert.equal(actionStorage.mode, 'explicit');
  assert.equal(actionStorage.persistent, false);
});

test('action log follows an explicit refund log when no action path is set', () => {
  const storage = resolveActionLogPath({
    REFUND_LOG_PATH: '/tmp/refund-management/refunds.jsonl',
  });

  assert.equal(storage.logPath, path.resolve('/tmp/refund-management/actions.jsonl'));
  assert.equal(storage.mode, 'refund-log-sibling');
});
