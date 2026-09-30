# Robux Backtrack Pro P4 E2E

P4 validates the paid path without touching the public free plugin or maintainer production backend.

## Hard isolation rule

Use a separate Pro staging deployment with separate secrets and storage:

```text
PRO staging service
  ROBLOX_WEBHOOK_SECRET = staging-only
  REFUND_API_KEY         = staging-only
  ACTION_API_KEY         = staging-only
  Railway Volume         = staging-only
```

The CLI hard-refuses `refundmanagement-production.up.railway.app`.

Repository code does not provision a Railway service. Create the staging service separately before running the Roblox Studio portion.

## Signed refund sender

Set the values from `.env.e2e.example` in your shell, then:

```bash
npm run e2e:refund -- --notification-id e2e-refund-001 --transaction-id e2e-tx-001
```

Add `--wait` to wait for `APPLIED`, `FAILED`, or `IGNORED`:

```bash
npm run e2e:refund -- --notification-id e2e-refund-001 --transaction-id e2e-tx-001 --wait
```

The sender uses the real `POST /webhooks/roblox` endpoint and the same timestamp + exact-body HMAC path as a Roblox delivery.

## Studio matrix

The fixture under `roblox/e2e/` uses:

- UserId `123456789`
- ProductId `987654321`
- Forced-failure ProductId `987654322`
- Starting Gems `1000`
- Reversal `500`

Expected cases:

| Case | Expected |
| --- | --- |
| Normal refund | Gems 1000 -> 500, executions 1, action APPLIED |
| Same NotificationId again | Gems remains 500, executions remains 1 |
| Unknown ProductId | Gems remains 1000, action FAILED |
| Forced failure product | Gems remains 1000, action FAILED |
| ACK loss after local APPLIED | Recovery reaches APPLIED without a second deduction |

For ACK-loss, set `FaultMode` on `E2EBootstrap` to `AFTER_HANDLER_BEFORE_COMPLETE`. The runtime permits this only in Studio.

## Closure rule

CI validates backend contracts, HMAC generation, production-target refusal, and the Studio fixture source contract. P4 is only CLOSED after all five Studio cases are observed against a dedicated staging backend.
