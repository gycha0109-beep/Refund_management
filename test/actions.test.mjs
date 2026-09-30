import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionFromRefund,
  claimAction,
  completeAction,
  failAction,
  ignoreAction,
  isActionClaimable,
  reduceActionJournal,
  retryAction,
} from '../src/actions.mjs';

const refund = {
  NotificationId: 'refund-1',
  EventType: 'TransactionRefunded',
  EventTime: '2026-09-30T00:00:00.000Z',
  EventPayload: {
    UserId: 123,
    ProductId: 456,
    RobuxAmount: 400,
    TransactionId: 'tx-1',
  },
};

test('creates a pending action from a refund', () => {
  const action = actionFromRefund(refund, Date.parse('2026-09-30T00:00:01.000Z'));

  assert.equal(action.ActionId, refund.NotificationId);
  assert.equal(action.Status, 'PENDING');
  assert.equal(action.Attempt, 0);
  assert.equal(action.UserId, 123);
  assert.equal(action.ProductId, 456);
  assert.equal(action.RobuxAmount, 400);
  assert.equal(action.TransactionId, 'tx-1');
});

test('journal reduction keeps the latest state per action', () => {
  const pending = actionFromRefund(refund, 1_000);
  const processing = {
    ...pending,
    Status: 'PROCESSING',
    Attempt: 1,
    UpdatedAt: new Date(2_000).toISOString(),
  };

  const current = reduceActionJournal([pending, processing]);
  assert.equal(current.length, 1);
  assert.equal(current[0].Status, 'PROCESSING');
  assert.equal(current[0].Attempt, 1);
});

test('claim uses a lease and permits reclaim only after expiry', () => {
  const pending = actionFromRefund(refund, 1_000);
  const first = claimAction(pending, {
    leaseToken: 'lease-1',
    nowMs: 10_000,
    leaseMs: 60_000,
  });

  assert.equal(first.ok, true);
  assert.equal(first.action.Status, 'PROCESSING');
  assert.equal(first.action.Attempt, 1);

  const blocked = claimAction(first.action, {
    leaseToken: 'lease-2',
    nowMs: 20_000,
    leaseMs: 60_000,
  });
  assert.deepEqual(blocked, { ok: false, reason: 'action_already_leased' });

  const reclaimed = claimAction(first.action, {
    leaseToken: 'lease-3',
    nowMs: 80_000,
    leaseMs: 60_000,
  });
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.action.Attempt, 2);
  assert.equal(reclaimed.action.LeaseToken, 'lease-3');
});

test('complete is protected by lease token and idempotent for the same token', () => {
  const pending = actionFromRefund(refund, 1_000);
  const claimed = claimAction(pending, {
    leaseToken: 'lease-1',
    nowMs: 10_000,
  }).action;

  const wrong = completeAction(claimed, {
    leaseToken: 'wrong',
    nowMs: 20_000,
  });
  assert.deepEqual(wrong, { ok: false, reason: 'lease_token_mismatch' });

  const completed = completeAction(claimed, {
    leaseToken: 'lease-1',
    nowMs: 20_000,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.idempotent, false);
  assert.equal(completed.action.Status, 'APPLIED');

  const replay = completeAction(completed.action, {
    leaseToken: 'lease-1',
    nowMs: 30_000,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
});

test('failed action requires an explicit operator retry before it can be claimed again', () => {
  const pending = actionFromRefund(refund, 1_000);
  const claimed = claimAction(pending, {
    leaseToken: 'lease-1',
    nowMs: 10_000,
  }).action;
  const failed = failAction(claimed, {
    leaseToken: 'lease-1',
    error: 'datastore timeout',
    nowMs: 20_000,
  });

  assert.equal(failed.ok, true);
  assert.equal(failed.action.Status, 'FAILED');
  assert.equal(failed.action.LastError, 'datastore timeout');

  const blocked = claimAction(failed.action, {
    leaseToken: 'lease-2',
    nowMs: 30_000,
  });
  assert.deepEqual(blocked, { ok: false, reason: 'action_not_claimable' });

  const reset = retryAction(failed.action, { nowMs: 40_000 });
  assert.equal(reset.ok, true);
  assert.equal(reset.action.Status, 'PENDING');
  assert.equal(reset.action.LastError, null);

  const retried = claimAction(reset.action, {
    leaseToken: 'lease-2',
    nowMs: 50_000,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.action.Attempt, 2);
});

test('claimable filter includes pending and expired leases but not live leases or failed actions', () => {
  const pending = actionFromRefund(refund, 1_000);
  assert.equal(isActionClaimable(pending, 10_000), true);

  const live = claimAction(pending, {
    leaseToken: 'lease-live',
    nowMs: 10_000,
    leaseMs: 60_000,
  }).action;
  assert.equal(isActionClaimable(live, 20_000), false);
  assert.equal(isActionClaimable(live, 80_000), true);

  const failed = failAction(live, {
    leaseToken: 'lease-live',
    error: 'manual review',
    nowMs: 30_000,
  }).action;
  assert.equal(isActionClaimable(failed, 90_000), false);
});


test('operator can ignore pending or failed actions but not processing/applied actions', () => {
  const pending = actionFromRefund(refund, 1_000);

  const ignored = ignoreAction(pending, {
    reason: 'reward was already consumed',
    nowMs: 2_000,
  });
  assert.equal(ignored.ok, true);
  assert.equal(ignored.action.Status, 'IGNORED');
  assert.equal(ignored.action.ResolutionReason, 'reward was already consumed');

  const replay = ignoreAction(ignored.action, { nowMs: 3_000 });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);

  const processing = claimAction(pending, {
    leaseToken: 'lease-1',
    nowMs: 4_000,
  }).action;
  assert.deepEqual(
    ignoreAction(processing, { nowMs: 5_000 }),
    { ok: false, reason: 'action_not_ignorable' },
  );
});

test('operator retry only resets FAILED actions to PENDING', () => {
  const pending = actionFromRefund(refund, 1_000);
  const claimed = claimAction(pending, {
    leaseToken: 'lease-1',
    nowMs: 2_000,
  }).action;
  const failed = failAction(claimed, {
    leaseToken: 'lease-1',
    error: 'temporary datastore failure',
    nowMs: 3_000,
  }).action;

  const reset = retryAction(failed, { nowMs: 4_000 });
  assert.equal(reset.ok, true);
  assert.equal(reset.action.Status, 'PENDING');
  assert.equal(reset.action.Attempt, 1);
  assert.equal(reset.action.LastError, null);
  assert.equal(reset.action.LeaseToken, null);

  assert.deepEqual(
    retryAction(claimed, { nowMs: 5_000 }),
    { ok: false, reason: 'action_not_retryable' },
  );
});
