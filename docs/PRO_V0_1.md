# Robux Backtrack Pro v0.1

Status: design + P1 backend implementation on `feat/pro-action-queue-v0`.

## Product boundary

Free remains a refund monitor.

Pro begins where refund handling becomes operational:

```text
Transaction Refunded
        |
        v
Refund log
        |
        v
PENDING action
        |
        v
Game server claims action
        |
        v
Developer product handler
        |
        +--> APPLIED
        |
        +--> FAILED -> retry
```

The backend does not decide how to reverse a purchase. Each game owns that rule.

## P1 action queue contract

Each refund creates one action keyed by Roblox `NotificationId`.

States:

- `PENDING`
- `PROCESSING`
- `APPLIED`
- `FAILED`
- `IGNORED` (reserved for the Pro Studio UI)

Action state is stored as an append-only JSONL journal. The latest record for an `ActionId` is the current state.

### Authentication

Action APIs use a separate secret:

```http
x-action-api-key: ACTION_API_KEY
```

Do not reuse the Studio read-only `REFUND_API_KEY`.

### Read queue

The game server polls only actions that are safe for automatic claiming:

```http
GET /api/actions?claimable=true&limit=20
```

This returns new `PENDING` actions and `PROCESSING` actions whose lease expired. It intentionally excludes `FAILED` actions so a handler failure does not trigger an automatic second deduction. Operators can still inspect failures with `?status=FAILED`.

### Claim

```http
POST /api/actions/{notificationId}/claim
x-action-api-key: ...
content-type: application/json

{"leaseSeconds":60}
```

The server returns a random `LeaseToken`. A live lease prevents a second worker from claiming the same action. Expired leases can be reclaimed and increment `Attempt`.

### Complete

```http
POST /api/actions/{notificationId}/complete
x-action-api-key: ...
content-type: application/json

{"leaseToken":"..."}
```

Completion with the same token is idempotent.

### Fail

```http
POST /api/actions/{notificationId}/fail
x-action-api-key: ...
content-type: application/json

{"leaseToken":"...","error":"datastore timeout"}
```

A failed action is claimable again.

## Important delivery guarantee

The backend lease alone cannot guarantee exactly-once mutation inside a Roblox DataStore. A server can apply a reversal and crash before acknowledging completion.

P2 must therefore make the Roblox server module persist a per-refund idempotency marker before/with the game-specific handler. The target property is safe retry, not a false distributed exactly-once guarantee.

## P2 server SDK

The first server SDK lives in `roblox/RobuxBacktrackServer.lua`.

Responsibilities implemented:

1. Poll claimable actions with bounded jitter.
2. Claim an action with a backend lease.
3. Resolve `ProductId` to a developer callback.
4. Create a game-side DataStore marker keyed from `NotificationId`.
5. Refuse to automatically re-run an action whose local marker is already `STARTED` or `FAILED`.
6. Recover a backend acknowledgement safely when the local marker is already `APPLIED`.
7. Mark remote success with `complete` or failure with `fail`.
8. Read `ACTION_API_KEY` through Roblox Secrets Store, never a client script.

The safe default is intentionally conservative: uncertain local execution becomes manual review rather than an automatic second deduction.

Next: P3 product handler templates + Studio installer/config UI.
