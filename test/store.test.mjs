import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, mapAction } from '../src/store.mjs';

test('defaults to JSONL storage when Supabase is not configured', () => {
  const store = createStore({});
  const info = store.describe();

  assert.equal(info.mode, 'jsonl');
  assert.equal(info.refundPersistent, false);
  assert.equal(info.actionPersistent, false);
});

test('requires Supabase URL and secret key together', () => {
  assert.throws(
    () => createStore({ SUPABASE_URL: 'https://example.supabase.co' }),
    /must be configured together/,
  );

  assert.throws(
    () => createStore({ SUPABASE_SECRET_KEY: 'sb_secret_test' }),
    /must be configured together/,
  );
});

test('Supabase store sends the secret only in the apikey header', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const store = createStore({
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  }, { fetchImpl });

  const actions = await store.listActions({ status: 'FAILED', limit: 10 });
  assert.deepEqual(actions, []);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/rb_list_actions');
  assert.equal(calls[0].options.headers.apikey, 'sb_secret_test');
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test('maps Postgres action rows to the public action contract', () => {
  const mapped = mapAction({
    action_id: 'n-1',
    notification_id: 'n-1',
    transaction_id: 'tx-1',
    user_id: 123,
    product_id: 456,
    robux_amount: 400,
    status: 'FAILED',
    attempt: 2,
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:01:00Z',
    lease_token: 'lease',
    lease_expires_at: null,
    last_error: 'failure',
    resolution_reason: null,
  });

  assert.equal(mapped.ActionId, 'n-1');
  assert.equal(mapped.Status, 'FAILED');
  assert.equal(mapped.Attempt, 2);
  assert.equal(mapped.LastError, 'failure');
});
