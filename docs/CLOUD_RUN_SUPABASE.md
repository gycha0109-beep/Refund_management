# Cloud Run + Supabase deployment

This is the target production architecture for Robux Backtrack Pro:

```text
Roblox Transaction Refunded webhook
        |
        v
Google Cloud Run
        |
        v
Supabase Data API
        |
        v
Postgres refunds + refund_actions
```

Cloud Run is stateless. Durable refund/action state lives in Supabase Postgres.

## Required backend environment

```text
ROBLOX_WEBHOOK_SECRET
REFUND_API_KEY
ACTION_API_KEY
SUPABASE_URL
SUPABASE_SECRET_KEY
```

Use a Supabase backend **secret key** (`sb_secret_...`) rather than a publishable key. It is server-only and must never be embedded in a Roblox plugin or game source.

The backend sends the Supabase secret only through the `apikey` HTTP header. It does not send it as an Authorization bearer token.

## Supabase setup

Apply:

```text
supabase/migrations/202609300001_robux_backtrack.sql
```

The migration creates:

- `refunds`
- `refund_actions`
- atomic RPCs for ingest, queue reads, claim, complete, fail, ignore, and retry
- RLS on both tables with no public policies

This is deliberate: browser/client roles have no table access. Cloud Run uses the server-side Supabase secret.

## Why RPCs

A Cloud Run service can have more than one instance. An in-process mutex cannot protect refund claims across instances.

The database RPCs make the important state transitions conditional in Postgres:

- only PENDING or expired PROCESSING can be claimed;
- FAILED must be explicitly reset to PENDING by Studio Retry;
- complete/fail require the current lease token;
- duplicate webhook NotificationId values are de-duplicated by a primary key.

## Cloud Run container

The repository contains a Dockerfile. The process listens on `PORT`, which Cloud Run provides automatically.

Example deployment after Google Cloud CLI authentication:

```bash
gcloud run deploy robux-backtrack-pro \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --min 0 \
  --max 3
```

The service must be public because Roblox must be able to POST the webhook endpoint. Application-level webhook HMAC validation remains mandatory.

Set non-secret configuration such as `SUPABASE_URL` as an environment variable. Store the four credentials as deployment secrets rather than committing them.

## Health check

After deployment:

```text
GET https://YOUR-CLOUD-RUN-URL/health
```

Expected durable-store fields:

```json
{
  "storagePersistent": true,
  "storageMode": "supabase-postgres",
  "actionStoragePersistent": true,
  "actionStorageMode": "supabase-postgres",
  "dataStore": "supabase",
  "supabaseConfigured": true
}
```

## Migration from Railway JSONL

Do not switch the Roblox webhook URL until the Cloud Run service passes health and the Pro E2E matrix.

The current Railway production service remains unchanged during migration. Existing JSONL data can be imported separately if historical data is worth preserving; the first cut does not silently copy or delete it.

Recommended cutover:

```text
1. Create isolated Supabase project
2. Apply migration
3. Deploy Cloud Run with new staging secrets
4. Run P4 E2E-1..E2E-5
5. Point Roblox staging webhook to Cloud Run
6. Observe
7. Only then plan production cutover
```
