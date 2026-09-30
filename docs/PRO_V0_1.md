# Robux Backtrack Pro v0.1

Status: P1 action queue, P2 server SDK, P3 installer/configurator, P4 E2E harness, and P5 operator UI are implemented on `feat/pro-action-queue-v0`. P4 still requires live Roblox Studio staging validation before closure.

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
        +--> FAILED -> manual review / controlled retry
```

The backend never guesses how to reverse a purchase. Each game owns that rule.

## P1 action queue contract

Each refund creates one action keyed by Roblox `NotificationId`.

States:

- `PENDING`
- `PROCESSING`
- `APPLIED`
- `FAILED`
- `IGNORED`

Action state is stored as an append-only JSONL journal. The latest record for an `ActionId` is the current state.

### Authentication

Action APIs use a separate secret:

```http
x-action-api-key: ACTION_API_KEY
```

`ACTION_API_KEY` is reserved for the Roblox game-server runtime. Studio operator reads and manual `ignore` / `retry` transitions use the existing `REFUND_API_KEY`, so the runtime secret never needs to be stored in plugin settings.

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

Failed actions are deliberately not returned by the automatic claimable queue.

## P2 server SDK

The SDK lives in `roblox/RobuxBacktrackServer.lua`.

It polls claimable actions, takes a backend lease, maps `ProductId` to a developer callback, writes a local DataStore execution marker, and then acknowledges success/failure.

The safe default is conservative:

- Local `APPLIED` + lost backend ACK -> reclaim and ACK without running the handler twice.
- Local `STARTED` or `FAILED` -> stop automatic execution and require review.
- Unknown ProductId -> fail closed.

This is safe retry behavior, not a false distributed exactly-once guarantee.

## P3 Studio installer/configurator

The Pro plugin prototype lives in `plugin/RobuxBacktrackPro.plugin.lua`.

It can:

1. Save backend URL and the **name** of the Roblox secret. It never stores the `ACTION_API_KEY` value.
2. Health-check the Pro backend.
3. Install/update a managed server runtime under `ServerScriptService/RobuxBacktrackPro`.
4. Preserve developer-owned `ProductHandlers` code during runtime updates.
5. Add a safe handler stub for a numeric Developer Product ID.
6. Open `ProductHandlers` directly in the Script Editor.
7. Validate runtime presence, handler count/TODO handlers, backend action-key configuration, and persistent action storage.

Installed structure:

```text
ServerScriptService
└── RobuxBacktrackPro
    ├── RobuxBacktrackServer   (ModuleScript, plugin-managed)
    ├── ProductHandlers        (ModuleScript, developer-owned body)
    └── Bootstrap              (Script, plugin-managed)
```

New handler stubs intentionally return `false, "handler_not_implemented"` until the developer replaces the TODO. This prevents an unimplemented reversal from being silently marked `APPLIED`.

The plugin writes script source through `ScriptEditorService:UpdateSourceAsync()` and refuses to overwrite unknown developer scripts.

## Manual requirements

The experience owner must still:

1. Enable **Allow HTTP Requests** in Experience Settings -> Security.
2. Put the backend `ACTION_API_KEY` value into Roblox Secrets Store using the configured secret name (default: `RobuxBacktrackActionKey`).
3. Implement each ProductId handler against the game's own persistent data model.
4. Test with a controlled fake refund before enabling real operational use.

## P4 E2E harness

P4 implementation is now present in:

- `scripts/e2e-refund.mjs`: signed synthetic refund sender plus terminal-state waiter.
- `roblox/e2e/`: Studio-only 1000 -> 500 Gems fixture, forced failure path, inspection scripts, and an ACK-loss bootstrap.
- `docs/PRO_E2E_TEST.md`: staging isolation and the five-case validation matrix.

The runtime now supports one Studio-only fault mode, `AFTER_HANDLER_BEFORE_COMPLETE`, to reproduce the dangerous case where the game mutation succeeded but the backend acknowledgement was lost.

Repository CI verifies the harness and backend contracts. P4 is not considered CLOSED until the Roblox Studio fixture is actually run against a dedicated staging deployment and all five cases are observed.

## P5 Studio operator UI

The Pro plugin now includes an operations section that can read the latest action journal through the Studio `REFUND_API_KEY`.

It supports:

- filters for `PENDING`, `FAILED`, `PROCESSING`, `APPLIED`, and `IGNORED`;
- manual `Ignore` for `PENDING` / `FAILED`;
- explicit `Retry` for `FAILED`, which resets it to `PENDING`;
- a two-click confirmation before Ignore;
- read-only display for `PROCESSING` and terminal `APPLIED` / `IGNORED`.

A failed action can no longer be claimed directly. It must first pass through the operator retry transition. This prevents a runtime worker from silently retrying a potentially non-idempotent failed reversal.

The Studio key is the existing backend `REFUND_API_KEY`. The game-server `ACTION_API_KEY` remains separate and stays in Roblox Secrets Store.

Next after live P4 validation: polish the operator cards, package the paid asset, and perform release-candidate testing.


## Durable hosting migration

The Pro branch now supports stateless Cloud Run hosting backed by Supabase Postgres.

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are configured together:

- webhook de-duplication moves to a Postgres primary key;
- action state is stored in `refund_actions`;
- claim/complete/fail/ignore/retry transitions are executed atomically through Postgres RPCs;
- Cloud Run instances no longer depend on a shared local filesystem or an in-process action lock.

The JSONL implementation remains as the local/test and existing free-deployment fallback.

See `docs/CLOUD_RUN_SUPABASE.md`.
