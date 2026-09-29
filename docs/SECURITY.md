# Security Model

## Secrets

There are two separate credentials:

- `ROBLOX_WEBHOOK_SECRET`: server-only. Verifies webhook deliveries.
- `REFUND_API_KEY`: grants read access to the refund API.

Never put `ROBLOX_WEBHOOK_SECRET` in the Studio plugin.

## Public beta model

The Creator Store beta is BYO-backend:

```text
Developer's Roblox webhook
        |
        v
Developer's backend deployment
        |
        | refund-read API key
        v
Refund Logger Studio plugin
```

Each developer is expected to control the backend they configure.

This avoids distributing one shared maintainer API key to every plugin installation.

## Not a hosted SaaS auth model

A shared hosted backend for unrelated developers would require at minimum:

- tenant isolation,
- per-install or per-user credentials,
- revocation,
- scoped refund access,
- secure onboarding/pairing,
- audit logging,
- and a migration away from one global `REFUND_API_KEY`.

Do not expose the current single-tenant backend as a public shared service.
