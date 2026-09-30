import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile('supabase/migrations/202609300001_robux_backtrack.sql', 'utf8');

test('Supabase migration creates durable refund/action tables with RLS', () => {
  assert.match(sql, /create table if not exists public\.refunds/i);
  assert.match(sql, /create table if not exists public\.refund_actions/i);
  assert.match(sql, /enable row level security/i);
});

test('Supabase migration exposes atomic action RPCs', () => {
  for (const fn of [
    'rb_ingest_refund',
    'rb_list_actions',
    'rb_claim_action',
    'rb_complete_action',
    'rb_fail_action',
    'rb_ignore_action',
    'rb_retry_action',
  ]) {
    assert.match(sql, new RegExp(`function public\\.${fn}`, 'i'));
  }
});

test('automatic claims exclude FAILED until explicit retry', () => {
  const claimBody = sql.slice(
    sql.indexOf('create or replace function public.rb_claim_action'),
    sql.indexOf('create or replace function public.rb_complete_action'),
  );
  assert.equal(/status\s*=\s*'FAILED'/i.test(claimBody), false);
});
