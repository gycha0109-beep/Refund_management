# Refund Logger — Creator Store Beta

## Listing

**Name:** Refund Logger

**Tagline:** See Roblox transaction refunds inside Studio.

**Beta description:**

Refund Logger is a small Studio utility for developers who want a visible audit trail for Roblox `Transaction Refunded` webhook events.

The beta shows recent refund notifications in a dockable Studio panel. It does **not** automatically revoke entitlements, change player data, or make economy decisions.

### What the beta does

- Displays recent Transaction Refunded events in Studio
- Shows user, product, Robux amount, transaction ID, and refund time when those fields are present
- Keeps webhook ingestion separate from Studio
- Authenticates refund reads with a separate API key
- Supports persistent storage when the backend uses a Railway Volume

### Beta setup

This build is **bring-your-own-backend**. The plugin does not contain the maintainer's webhook secret or API key.

1. Deploy the backend from this repository.
2. Configure `ROBLOX_WEBHOOK_SECRET` and `REFUND_API_KEY`.
3. Register `/webhooks/roblox` for Roblox's Transaction Refunded webhook.
4. Open Refund Logger in Studio.
5. Enter your backend URL and `REFUND_API_KEY`.
6. Click **Save**, then **Test**.

### Privacy / security

- No webhook secret is embedded in the plugin.
- The plugin only sends the configured refund-read API key to the backend URL entered by the developer.
- Credentials are stored locally through Roblox Studio plugin settings.
- Do not reuse your Roblox webhook secret as the refund-read API key.

### Beta limitation

This release intentionally has no hosted account system or multi-tenant SaaS authentication. A future hosted edition would require per-install, revocable credentials before multiple unrelated developers could safely share one backend.
