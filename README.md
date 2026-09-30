# Refund Management

Roblox Transaction Refunded webhook logger and Studio viewer.

## Scope

- Receive Roblox webhook notifications
- Verify `roblox-signature` HMAC against the exact raw request body
- Reject stale webhook deliveries to reduce replay risk
- Persist refund events to JSONL storage
- De-duplicate events by `NotificationId`
- Protect refund reads with a separate `REFUND_API_KEY`
- Expose recent refund events over a small HTTP API
- Provide a Roblox Studio plugin panel for viewing recent events

Automatic entitlement revocation remains out of scope for the free MVP. Experimental Pro work is isolated on a feature branch and adds a leased refund action queue plus a server-side handler SDK; it is not part of the currently published free plugin.

## Maintainer test deployment

```text
https://refundmanagement-production.up.railway.app
```

Useful checks:

```text
GET /
GET /health
GET /api/refunds?limit=20
```

## Environment

```text
PORT=8787
ROBLOX_WEBHOOK_SECRET=...
REFUND_API_KEY=...
REFUND_LOG_PATH=./data/refunds.jsonl
```

`REFUND_LOG_PATH` is optional on Railway. If a Railway Volume is attached, the app automatically uses `RAILWAY_VOLUME_MOUNT_PATH/refunds.jsonl`.

`ROBLOX_WEBHOOK_SECRET` authenticates Roblox webhook deliveries.

`REFUND_API_KEY` is a separate secret used only by the Studio plugin when reading refund events. Do not reuse the webhook secret.

## Run locally

```bash
cp .env.example .env
npm start
```

Server defaults to `http://localhost:8787`.

## Endpoints

- `GET /`
- `GET /health`
- `POST /webhooks/roblox`
- `POST /webhooks/roblox/refund` (alias)
- `GET /api/refunds?limit=20`

Refund reads require:

```http
x-refund-api-key: YOUR_REFUND_API_KEY
```

If the server has no `REFUND_API_KEY`, `/api/refunds` returns `503`. Missing or incorrect client keys return `401`.

## Roblox webhook setup

In Creator Hub, open **Account Settings -> Webhooks** and add:

```text
https://refundmanagement-production.up.railway.app/webhooks/roblox
```

Configure a webhook secret and enable **Transaction Refunded**. Put the same secret in Railway as `ROBLOX_WEBHOOK_SECRET`.

Roblox signs the exact request body. Do not parse and re-serialize JSON before signature verification.

## Railway

Railway supplies `PORT`; the server listens on it automatically.

Add both secrets under Railway Variables:

```text
ROBLOX_WEBHOOK_SECRET=...
REFUND_API_KEY=...
```

For persistent MVP storage, attach a Railway Volume to this service. A mount path such as `/data` is sufficient.

Railway automatically exposes `RAILWAY_VOLUME_MOUNT_PATH`. When present, the app writes to `<mount>/refunds.jsonl` automatically, so no extra `REFUND_LOG_PATH` variable is required.

`GET /health` reports:

- `storagePersistent: true`
- `storageMode: "railway-volume"`

when the app is actually using the mounted Railway Volume.

Without a volume, the fallback `./data/refunds.jsonl` is ephemeral and can be lost on redeploy/restart.

## Studio plugin

`plugin/RefundLogger.plugin.lua` creates a dockable Studio panel.

The public beta intentionally ships with **no backend URL and no credential embedded**. Enter the URL of the backend you control and the same `REFUND_API_KEY` configured on that backend, click **Save**, then **Test** or **Refresh**.

The plugin uses `HttpService:RequestAsync()` and sends the API key in the `x-refund-api-key` header. Studio may prompt the user to approve HTTP access to the Railway domain the first time it connects.

For this BYO-backend beta, the API key is stored with `Plugin:SetSetting()` on the local Studio installation. This is intentionally a single-tenant developer-tool model, not hosted multi-tenant SaaS authentication. See `docs/SECURITY.md` and `docs/CREATOR_STORE_BETA.md`.

## Tests

```bash
npm run check
npm test
```

Tests cover:

- Roblox raw-body HMAC verification
- stale signature rejection
- refund de-duplication
- missing/wrong/correct refund API keys
- server behavior when the refund API key is unconfigured
- end-to-end signed webhook storage and authenticated refund retrieval

## Security note

Never commit either secret. Use Railway Variables / deployment secrets.


## Pro development

The published free plugin remains `plugin/RefundLogger.plugin.lua`.

Experimental paid-version work is isolated on `feat/pro-action-queue-v0`:

- `src/actions.mjs`: leased refund action queue
- `roblox/RobuxBacktrackServer.lua`: server-side execution SDK
- `plugin/RobuxBacktrackPro.plugin.lua`: Studio installer/configurator prototype
- `docs/PRO_V0_1.md`: architecture and rollout contract

The Pro plugin stores only the backend URL and Roblox **secret name** in plugin settings. The `ACTION_API_KEY` value belongs in Roblox Secrets Store and must not be embedded in plugin or game source.


## Pro durable hosting target: Cloud Run + Supabase

The Pro branch can use Supabase Postgres instead of local/Railway JSONL storage. Configure both:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
```

When both are present, refund and action persistence switches to `supabase-postgres`. Without them, the legacy JSONL store remains available for local tests and the existing free deployment.

Cloud Run deployment instructions and cutover rules are in `docs/CLOUD_RUN_SUPABASE.md`. Database DDL/RPCs live in `supabase/migrations/202609300001_robux_backtrack.sql`.
