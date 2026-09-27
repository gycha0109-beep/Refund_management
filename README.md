# Refund Management

Minimal Roblox refund webhook logger MVP.

## Scope

- Receive Roblox webhook notifications
- Verify `roblox-signature` HMAC
- Persist refund events to local JSONL storage
- Expose recent refund events over a small HTTP API
- Provide a Roblox Studio plugin panel for viewing recent events

Automatic entitlement revocation, billing, SaaS accounts, and team features are intentionally out of scope for this MVP.

## Run locally

```bash
cp .env.example .env
npm start
```

Server defaults to `http://localhost:8787`.

## Endpoints

- `GET /health`
- `POST /webhooks/roblox`
- `GET /api/refunds?limit=20`

## Roblox webhook setup

In Creator Hub, create a webhook endpoint pointing at:

```text
https://YOUR_PUBLIC_HOST/webhooks/roblox
```

Configure a secret and enable the **Transaction Refunded** event. Put the same secret in `ROBLOX_WEBHOOK_SECRET`.

## Studio plugin

`plugin/RefundLogger.plugin.lua` creates a dockable Studio panel. Set the API base URL in the panel, save it, and refresh to view recent refund events.

## Security note

Never commit the webhook secret. Use environment variables / deployment secrets.
