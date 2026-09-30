# Robux Backtrack Pro v0.1

Status: P1 action queue, P2 server SDK, and P3 Studio installer/configurator are implemented on `feat/pro-action-queue-v0`.

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
- `IGNORED` (reserved for the Pro operations UI)

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

## Next phase

P4 is an end-to-end fixture/demo:

```text
fake refund
 -> backend PENDING
 -> Roblox server claim
 -> sample persistent balance mutation
 -> local idempotency marker
 -> backend APPLIED
```

P5 then adds the operational Pro UI for PENDING/APPLIED/FAILED/IGNORED review.
