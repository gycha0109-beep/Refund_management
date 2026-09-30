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

```http
GET /api/actions?status=PENDING&limit=20
```

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

## Next phase

P2: Roblox server SDK / ModuleScript.

Responsibilities:

1. Poll pending actions.
2. Claim one action.
3. Resolve `ProductId` to a developer callback.
4. Use `NotificationId` as the game-side idempotency key.
5. Mark success with `complete` or failure with `fail`.
6. Never place `ACTION_API_KEY` in a public client script.
