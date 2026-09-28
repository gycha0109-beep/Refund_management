import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRefundLogPath } from '../src/storage.mjs';

test('uses Railway volume automatically when attached', () => {
  const storage = resolveRefundLogPath({
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
  });

  assert.equal(storage.logPath, path.resolve('/data/refunds.jsonl'));
  assert.equal(storage.mode, 'railway-volume');
  assert.equal(storage.persistent, true);
});

test('falls back to ephemeral local storage without a volume', () => {
  const storage = resolveRefundLogPath({});

  assert.equal(storage.logPath, path.resolve('./data/refunds.jsonl'));
  assert.equal(storage.mode, 'ephemeral');
  assert.equal(storage.persistent, false);
});

test('explicit REFUND_LOG_PATH overrides the automatic volume path', () => {
  const storage = resolveRefundLogPath({
    REFUND_LOG_PATH: '/custom/refunds.jsonl',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
  });

  assert.equal(storage.logPath, path.resolve('/custom/refunds.jsonl'));
  assert.equal(storage.mode, 'explicit');
  assert.equal(storage.persistent, false);
});
