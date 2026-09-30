import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(
  'supabase/migrations/202609300002_harden_robux_backtrack.sql',
  'utf8',
);

test('Supabase RPC functions pin search_path', () => {
  const functions = [
    'rb_ingest_refund',
    'rb_list_actions',
    'rb_claim_action',
    'rb_complete_action',
    'rb_fail_action',
    'rb_ignore_action',
    'rb_retry_action',
  ];

  for (const fn of functions) {
    assert.match(
      sql,
      new RegExp(`alter function public\\.${fn}\\([^;]+set search_path = public, pg_temp`, 'is'),
    );
  }
});

test('anonymous and authenticated roles lose direct table and RPC access', () => {
  assert.match(sql, /revoke all on table public\.refunds from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.refund_actions from public, anon, authenticated/i);

  for (const fn of [
    'rb_ingest_refund',
    'rb_list_actions',
    'rb_claim_action',
    'rb_complete_action',
    'rb_fail_action',
    'rb_ignore_action',
    'rb_retry_action',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke execute on function public\\.${fn}`, 'i'),
    );
  }
});

test('service_role retains the backend privileges', () => {
  assert.match(sql, /grant select, insert, update, delete on table public\.refunds to service_role/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.refund_actions to service_role/i);
  assert.match(sql, /grant execute on function public\.rb_ingest_refund\(jsonb\) to service_role/i);
});
