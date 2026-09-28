# Refund Management

Roblox Transaction Refunded webhook logger MVP.

## Scope

- Receive Roblox webhook notifications
- Verify `roblox-signature` HMAC against the exact raw request body
- Reject stale webhook deliveries to reduce replay risk
- Persist refund events to JSONL storage
- De-duplicate events by `NotificationId`
- Protect refund reads with a separate `REFUND_API_KEY`
- Expose recent refund events over a small HTTP API
- Provide a Roblox Studio plugin panel for viewing recent events

Automatic entitlement revocation, billing, SaaS accounts, multi-tenancy, and team features are intentionally out of scope for this MVP.

## Production URL

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

The plugin defaults to the production Railway URL. Enter the same `REFUND_API_KEY` configured in Railway, click **Save**, then **Test** or **Refresh**.

The plugin uses `HttpService:RequestAsync()` and sends the API key in the `x-refund-api-key` header. Studio may prompt the user to approve HTTP access to the Railway domain the first time it connects.

For this single-user MVP, the API key is stored with `Plugin:SetSetting()` on the local Studio installation. That is convenient, not a production-grade multi-tenant authentication model. A public Creator Store release should move to per-install, revocable credentials.

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
