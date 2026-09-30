import crypto from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  actionFromRefund,
  claimAction,
  completeAction,
  failAction,
  findCurrentAction,
  ignoreAction,
  isActionClaimable,
  reduceActionJournal,
  retryAction,
} from './actions.mjs';
import { resolveActionLogPath, resolveRefundLogPath } from './storage.mjs';

function clampLimit(value) {
  const parsed = Number(value ?? 20);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.trunc(parsed) : 20, 100));
}

function mapAction(row) {
  if (!row) return null;

  return {
    RecordType: 'ACTION_STATE',
    ActionId: row.action_id,
    NotificationId: row.notification_id,
    TransactionId: row.transaction_id,
    UserId: row.user_id,
    ProductId: row.product_id,
    RobuxAmount: row.robux_amount,
    Status: row.status,
    Attempt: row.attempt,
    CreatedAt: row.created_at,
    UpdatedAt: row.updated_at,
    LeaseToken: row.lease_token,
    LeaseExpiresAt: row.lease_expires_at,
    LastError: row.last_error,
    ResolutionReason: row.resolution_reason,
  };
}

async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonl(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

class FileStore {
  constructor(env = process.env) {
    this.refundStorage = resolveRefundLogPath(env);
    this.actionStorage = resolveActionLogPath(env);
    this.refundLogPath = this.refundStorage.logPath;
    this.actionLogPath = this.actionStorage.logPath;
    this.actionMutation = Promise.resolve();
  }

  describe() {
    return {
      mode: 'jsonl',
      refundMode: this.refundStorage.mode,
      actionMode: this.actionStorage.mode,
      refundPersistent: this.refundStorage.persistent,
      actionPersistent: this.actionStorage.persistent,
    };
  }

  async ping() {
    return true;
  }

  withActionLock(fn) {
    const run = this.actionMutation.then(fn, fn);
    this.actionMutation = run.catch(() => {});
    return run;
  }

  async readActionJournal() {
    return readJsonl(this.actionLogPath);
  }

  async ensureActionForRefund(refund) {
    return this.withActionLock(async () => {
      const journal = await this.readActionJournal();
      const existing = findCurrentAction(journal, refund.NotificationId);
      if (existing) return { created: false, action: existing };

      const action = actionFromRefund(refund);
      await appendJsonl(this.actionLogPath, action);
      return { created: true, action };
    });
  }

  async ingestRefund(refund) {
    const events = await readJsonl(this.refundLogPath);
    if (events.some((event) => event.NotificationId === refund.NotificationId)) {
      await this.ensureActionForRefund(refund);
      return { stored: false, duplicate: true };
    }

    const storedEvent = { ...refund, ReceivedAt: new Date().toISOString() };
    await appendJsonl(this.refundLogPath, storedEvent);
    await this.ensureActionForRefund(storedEvent);
    return { stored: true, duplicate: false };
  }

  async listRefunds({ limit = 20 } = {}) {
    const safeLimit = clampLimit(limit);
    const events = await readJsonl(this.refundLogPath);
    return events.slice(-safeLimit).reverse();
  }

  async listActions({ status = null, claimable = false, limit = 20 } = {}) {
    let actions = reduceActionJournal(await this.readActionJournal());

    if (status) {
      actions = actions.filter((action) => action.Status === status);
    } else if (claimable) {
      actions = actions.filter((action) => isActionClaimable(action));
    }

    actions.sort((a, b) => String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)));
    return actions.slice(0, clampLimit(limit));
  }

  async getAction(actionId) {
    return findCurrentAction(await this.readActionJournal(), actionId);
  }

  async mutateAction(actionId, transition) {
    return this.withActionLock(async () => {
      const journal = await this.readActionJournal();
      const current = findCurrentAction(journal, actionId);
      const result = transition(current);

      if (result.ok && !result.idempotent) {
        await appendJsonl(this.actionLogPath, result.action);
      }

      return result;
    });
  }

  claimAction(actionId, { leaseSeconds = 60 } = {}) {
    return this.mutateAction(actionId, (current) => claimAction(current, {
      leaseToken: crypto.randomUUID(),
      leaseMs: Number(leaseSeconds) * 1000,
    }));
  }

  completeAction(actionId, { leaseToken } = {}) {
    return this.mutateAction(actionId, (current) => completeAction(current, { leaseToken }));
  }

  failAction(actionId, { leaseToken, error } = {}) {
    return this.mutateAction(actionId, (current) => failAction(current, { leaseToken, error }));
  }

  ignoreAction(actionId, { reason } = {}) {
    return this.mutateAction(actionId, (current) => ignoreAction(current, { reason }));
  }

  retryAction(actionId) {
    return this.mutateAction(actionId, (current) => retryAction(current));
  }
}

class SupabaseStore {
  constructor({ url, secretKey, fetchImpl = fetch }) {
    this.url = String(url).replace(/\/+$/, '');
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
  }

  describe() {
    return {
      mode: 'supabase',
      refundMode: 'supabase-postgres',
      actionMode: 'supabase-postgres',
      refundPersistent: true,
      actionPersistent: true,
    };
  }

  async ping() {
    await this.request('GET', 'refunds?select=notification_id&limit=1');
    return true;
  }

  async request(method, resource, { body = null, headers = {} } = {}) {
    const requestHeaders = {
      apikey: this.secretKey,
      accept: 'application/json',
      ...headers,
    };

    const options = {
      method,
      headers: requestHeaders,
    };

    if (body !== null) {
      requestHeaders['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.url}/rest/v1/${resource}`, options);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message = payload?.message || payload?.error || `supabase_http_${response.status}`;
      throw new Error(message);
    }

    return payload;
  }

  async rpc(name, args = {}) {
    return this.request('POST', `rpc/${name}`, {
      body: args,
    });
  }

  async ingestRefund(refund) {
    const storedEvent = { ...refund, ReceivedAt: new Date().toISOString() };
    return this.rpc('rb_ingest_refund', { p_event: storedEvent });
  }

  async listRefunds({ limit = 20 } = {}) {
    const safeLimit = clampLimit(limit);
    const rows = await this.request(
      'GET',
      `refunds?select=event&order=received_at.desc&limit=${safeLimit}`,
    );
    return rows.map((row) => row.event);
  }

  async listActions({ status = null, claimable = false, limit = 20 } = {}) {
    const rows = await this.rpc('rb_list_actions', {
      p_status: status,
      p_claimable: Boolean(claimable),
      p_limit: clampLimit(limit),
    });
    return rows.map(mapAction);
  }

  async getAction(actionId) {
    const encoded = encodeURIComponent(actionId);
    const rows = await this.request(
      'GET',
      `refund_actions?select=*&action_id=eq.${encoded}&limit=1`,
    );
    return rows.length ? mapAction(rows[0]) : null;
  }

  async claimAction(actionId, { leaseSeconds = 60 } = {}) {
    const result = await this.rpc('rb_claim_action', {
      p_action_id: actionId,
      p_lease_token: crypto.randomUUID(),
      p_lease_seconds: Number(leaseSeconds),
    });
    return {
      ...result,
      action: mapAction(result.action),
    };
  }

  async completeAction(actionId, { leaseToken } = {}) {
    const result = await this.rpc('rb_complete_action', {
      p_action_id: actionId,
      p_lease_token: leaseToken ?? null,
    });
    return {
      ...result,
      action: mapAction(result.action),
    };
  }

  async failAction(actionId, { leaseToken, error } = {}) {
    const result = await this.rpc('rb_fail_action', {
      p_action_id: actionId,
      p_lease_token: leaseToken ?? null,
      p_error: error ?? 'handler_failed',
    });
    return {
      ...result,
      action: mapAction(result.action),
    };
  }

  async ignoreAction(actionId, { reason } = {}) {
    const result = await this.rpc('rb_ignore_action', {
      p_action_id: actionId,
      p_reason: reason ?? 'manual_ignore',
    });
    return {
      ...result,
      action: mapAction(result.action),
    };
  }

  async retryAction(actionId) {
    const result = await this.rpc('rb_retry_action', {
      p_action_id: actionId,
    });
    return {
      ...result,
      action: mapAction(result.action),
    };
  }
}

export function createStore(env = process.env, { fetchImpl = fetch } = {}) {
  const url = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();

  if (Boolean(url) !== Boolean(secretKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be configured together');
  }

  if (url && secretKey) {
    return new SupabaseStore({
      url,
      secretKey,
      fetchImpl,
    });
  }

  return new FileStore(env);
}

export { FileStore, SupabaseStore, mapAction };
