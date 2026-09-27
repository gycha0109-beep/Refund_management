import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyApiKey } from '../src/auth.mjs';

test('accepts the configured refund API key', () => {
  assert.deepEqual(
    verifyApiKey({ provided: 'secret-key', expected: 'secret-key' }),
    { ok: true },
  );
});

test('rejects missing and incorrect refund API keys', () => {
  assert.deepEqual(
    verifyApiKey({ provided: undefined, expected: 'secret-key' }),
    { ok: false, reason: 'missing_api_key' },
  );

  assert.deepEqual(
    verifyApiKey({ provided: 'wrong-key', expected: 'secret-key' }),
    { ok: false, reason: 'api_key_mismatch' },
  );
});

test('reports an unconfigured server API key', () => {
  assert.deepEqual(
    verifyApiKey({ provided: 'anything', expected: '' }),
    { ok: false, reason: 'api_key_not_configured' },
  );
});
