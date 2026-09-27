# Refund Management

Minimal Roblox refund webhook logger MVP.

## Scope

- Receive Roblox webhook notifications
- Verify `roblox-signature` HMAC against the exact raw request body
- Reject stale webhook deliveries to reduce replay risk
- Persist refund events to JSONL storage
- De-duplicate events by `NotificationId`
- Expose recent refund events over a small HTTP API
- Provide a Roblox Studio plugin panel for viewing recent events

Automatic entitlement revocation, billing, SaaS accounts, and team features are intentionally out of scope for this MVP.

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

## Roblox webhook setup

In Creator Hub, open **Account Settings -> Webhooks** and add:

```text
https://refundmanagement-production.up.railway.app/webhooks/roblox
```

Configure a webhook secret and enable **Transaction Refunded**. Put the same secret in Railway as:

```text
ROBLOX_WEBHOOK_SECRET=...
```

Roblox signs the exact request body. Do not parse and re-serialize JSON before signature verification.

## Railway

Railway supplies `PORT`; the server listens on it automatically.

The default `./data/refunds.jsonl` file is suitable for MVP testing, but Railway service storage is ephemeral across redeploys/restarts unless persistent storage is attached. Before real use, attach a Railway Volume and point `REFUND_LOG_PATH` at the mounted path, or move the ledger to a database.

## Studio plugin

`plugin/RefundLogger.plugin.lua` creates a dockable Studio panel and defaults to the production Railway API above. Studio may ask the user to approve HTTP access to the domain the first time the plugin connects.

## Security note

Never commit the webhook secret. Use Railway Variables / deployment secrets.
