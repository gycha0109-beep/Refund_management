export const ACTION_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'APPLIED',
  'FAILED',
  'IGNORED',
]);

const CLAIMABLE_STATUSES = new Set(['PENDING', 'FAILED', 'PROCESSING']);
const TERMINAL_STATUSES = new Set(['APPLIED', 'IGNORED']);

function toIso(ms) {
  return new Date(ms).toISOString();
}

function normalizeLeaseMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(15_000, Math.min(Math.trunc(parsed), 300_000));
}

export function actionFromRefund(refund, nowMs = Date.now()) {
  if (!refund?.NotificationId) {
    throw new TypeError('refund NotificationId is required');
  }

  const payload = refund.EventPayload ?? {};
  const now = toIso(nowMs);

  return {
    RecordType: 'ACTION_STATE',
    ActionId: refund.NotificationId,
    NotificationId: refund.NotificationId,
    TransactionId: payload.TransactionId ?? null,
    UserId: payload.UserId ?? null,
    ProductId: payload.ProductId ?? null,
    RobuxAmount: payload.RobuxAmount ?? null,
    Status: 'PENDING',
    Attempt: 0,
    CreatedAt: now,
    UpdatedAt: now,
    LeaseToken: null,
    LeaseExpiresAt: null,
    LastError: null,
  };
}

export function reduceActionJournal(records) {
  const current = new Map();

  for (const record of records) {
    if (!record || record.RecordType !== 'ACTION_STATE' || !record.ActionId) continue;
    current.set(record.ActionId, record);
  }

  return [...current.values()];
}

export function findCurrentAction(records, actionId) {
  let current = null;

  for (const record of records) {
    if (record?.RecordType === 'ACTION_STATE' && record.ActionId === actionId) {
      current = record;
    }
  }

  return current;
}

export function isActionClaimable(action, nowMs = Date.now()) {
  if (!action) return false;
  if (action.Status === 'PENDING') return true;

  if (action.Status === 'PROCESSING') {
    if (!action.LeaseExpiresAt) return true;
    const leaseExpiry = Date.parse(action.LeaseExpiresAt);
    return !Number.isFinite(leaseExpiry) || leaseExpiry <= nowMs;
  }

  return false;
}

export function claimAction(action, {
  leaseToken,
  nowMs = Date.now(),
  leaseMs = 60_000,
} = {}) {
  if (!action) return { ok: false, reason: 'action_not_found' };
  if (!leaseToken || typeof leaseToken !== 'string') {
    return { ok: false, reason: 'lease_token_required' };
  }
  if (TERMINAL_STATUSES.has(action.Status)) {
    return { ok: false, reason: 'action_not_claimable' };
  }
  if (!CLAIMABLE_STATUSES.has(action.Status)) {
    return { ok: false, reason: 'action_not_claimable' };
  }

  if (action.Status === 'PROCESSING' && action.LeaseExpiresAt) {
    const leaseExpiry = Date.parse(action.LeaseExpiresAt);
    if (Number.isFinite(leaseExpiry) && leaseExpiry > nowMs) {
      return { ok: false, reason: 'action_already_leased' };
    }
  }

  const safeLeaseMs = normalizeLeaseMs(leaseMs);
  const next = {
    ...action,
    Status: 'PROCESSING',
    Attempt: Number(action.Attempt ?? 0) + 1,
    UpdatedAt: toIso(nowMs),
    LeaseToken: leaseToken,
    LeaseExpiresAt: toIso(nowMs + safeLeaseMs),
    LastError: null,
  };

  return { ok: true, action: next };
}

export function completeAction(action, {
  leaseToken,
  nowMs = Date.now(),
} = {}) {
  if (!action) return { ok: false, reason: 'action_not_found' };
  if (!leaseToken || typeof leaseToken !== 'string') {
    return { ok: false, reason: 'lease_token_required' };
  }

  if (action.Status === 'APPLIED') {
    if (action.LeaseToken === leaseToken) {
      return { ok: true, idempotent: true, action };
    }
    return { ok: false, reason: 'lease_token_mismatch' };
  }

  if (action.Status !== 'PROCESSING') {
    return { ok: false, reason: 'action_not_processing' };
  }
  if (action.LeaseToken !== leaseToken) {
    return { ok: false, reason: 'lease_token_mismatch' };
  }

  return {
    ok: true,
    idempotent: false,
    action: {
      ...action,
      Status: 'APPLIED',
      UpdatedAt: toIso(nowMs),
      LeaseExpiresAt: null,
      LastError: null,
    },
  };
}

export function failAction(action, {
  leaseToken,
  error = 'handler_failed',
  nowMs = Date.now(),
} = {}) {
  if (!action) return { ok: false, reason: 'action_not_found' };
  if (!leaseToken || typeof leaseToken !== 'string') {
    return { ok: false, reason: 'lease_token_required' };
  }

  if (action.Status === 'FAILED' && action.LeaseToken === leaseToken) {
    return { ok: true, idempotent: true, action };
  }

  if (action.Status !== 'PROCESSING') {
    return { ok: false, reason: 'action_not_processing' };
  }
  if (action.LeaseToken !== leaseToken) {
    return { ok: false, reason: 'lease_token_mismatch' };
  }

  const message = String(error || 'handler_failed').slice(0, 500);

  return {
    ok: true,
    idempotent: false,
    action: {
      ...action,
      Status: 'FAILED',
      UpdatedAt: toIso(nowMs),
      LeaseExpiresAt: null,
      LastError: message,
    },
  };
}
