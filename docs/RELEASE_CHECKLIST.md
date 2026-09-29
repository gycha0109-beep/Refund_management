# Creator Store Beta Release Checklist

## Code gate

- [ ] GitHub Actions CI passes on the release commit
- [ ] `GET /health` reports both secrets configured
- [ ] Persistent deployment reports `storagePersistent: true`
- [ ] No secret value exists in tracked plugin/source files
- [ ] Plugin default API URL is empty in the public beta build
- [ ] Plugin can save, test, refresh, and render a refund event

## Studio smoke test

1. Install/save the public beta plugin locally.
2. Open **Refund Logger**.
3. Confirm the first-run message asks for backend configuration.
4. Enter backend URL and refund-read API key.
5. Click **Save**.
6. Click **Test** and confirm authentication succeeds.
7. Click **Refresh** and confirm refund cards render.
8. Restart Studio and confirm saved settings still work.

## Creator Store listing

Use `docs/CREATOR_STORE_BETA.md` for listing copy.

Suggested category: developer utility / Studio plugin.

Suggested screenshots:

1. Empty first-run configuration screen.
2. Connected state with no refunds.
3. Connected state with a sample refund card.

Do not show real API keys, webhook secrets, transaction identifiers, or user IDs in listing screenshots. Use synthetic sample data.

## Release boundary

This beta is a BYO-backend developer tool. Do not market it as:

- automatic entitlement revocation,
- fraud prevention,
- chargeback prevention,
- a hosted multi-tenant service,
- or a guarantee that every refund can be mapped to in-game state.

Those require additional product and security work.
