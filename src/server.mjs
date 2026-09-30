import http from 'node:http';
import { ACTION_STATUSES } from './actions.mjs';
import { verifyApiKey } from './auth.mjs';
import { createStore } from './store.mjs';
import { isRefundEvent, validateEnvelope, verifyRobloxWebhook } from './webhook.mjs';

const port = Number(process.env.PORT ?? 8787);
const webhookSecret = process.env.ROBLOX_WEBHOOK_SECRET ?? '';
const refundApiKey = process.env.REFUND_API_KEY ?? '';
const actionApiKey = process.env.ACTION_API_KEY ?? '';
const store = createStore();
const storage = store.describe();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readRawJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('body_too_large');
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  const body = JSON.parse(rawBody || '{}');
  return { rawBody, body };
}

function authorizeWithKey(req, res, {
  expected,
  headerName,
}) {
  const verification = verifyApiKey({
    provided: req.headers[headerName],
    expected,
  });

  if (verification.ok) return true;

  if (verification.reason === 'api_key_not_configured') {
    sendJson(res, 503, { ok: false, error: verification.reason });
    return false;
  }

  sendJson(res, 401, { ok: false, error: verification.reason });
  return false;
}

function authorizeRefundRead(req, res) {
  return authorizeWithKey(req, res, {
    expected: refundApiKey,
    headerName: 'x-refund-api-key',
  });
}

function authorizeAction(req, res) {
  return authorizeWithKey(req, res, {
    expected: actionApiKey,
    headerName: 'x-action-api-key',
  });
}

function authorizeActionRead(req, res) {
  if (req.headers['x-refund-api-key'] !== undefined) {
    return authorizeRefundRead(req, res);
  }
  return authorizeAction(req, res);
}

function actionErrorStatus(reason) {
  if (reason === 'action_not_found') return 404;
  if (
    reason === 'action_already_leased'
    || reason === 'action_not_claimable'
    || reason === 'action_not_processing'
    || reason === 'action_not_ignorable'
    || reason === 'action_not_retryable'
    || reason === 'lease_token_mismatch'
  ) {
    return 409;
  }
  return 400;
}

function normalizeLimit(raw, fallback = 20) {
  const requested = Number(raw ?? fallback);
  return Math.max(
    1,
    Math.min(Number.isFinite(requested) ? Math.trunc(requested) : fallback, 100),
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        service: 'refund-management',
        version: '0.4.0-alpha.5',
        storage: storage.mode,
        endpoints: {
          health: '/health',
          webhook: '/webhooks/roblox',
          refunds: '/api/refunds?limit=20',
          actions: '/api/actions?claimable=true&limit=20',
          keepalive: '/internal/keepalive',
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'refund-management',
        webhookSecretConfigured: Boolean(webhookSecret),
        apiKeyConfigured: Boolean(refundApiKey),
        actionApiKeyConfigured: Boolean(actionApiKey),
        storagePersistent: storage.refundPersistent,
        storageMode: storage.refundMode,
        actionStoragePersistent: storage.actionPersistent,
        actionStorageMode: storage.actionMode,
        dataStore: storage.mode,
        supabaseConfigured: storage.mode === 'supabase',
      });
    }

    if (req.method === 'GET' && url.pathname === '/internal/keepalive') {
      if (!authorizeRefundRead(req, res)) return;

      await store.ping();
      return sendJson(res, 200, {
        ok: true,
        storage: storage.mode,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/refunds') {
      if (!authorizeRefundRead(req, res)) return;

      const limit = normalizeLimit(url.searchParams.get('limit'));
      const events = await store.listRefunds({ limit });
      return sendJson(res, 200, { count: events.length, events });
    }

    if (req.method === 'GET' && url.pathname === '/api/actions') {
      if (!authorizeActionRead(req, res)) return;

      const limit = normalizeLimit(url.searchParams.get('limit'));
      const requestedStatus = url.searchParams.get('status');
      const status = requestedStatus?.toUpperCase() ?? null;
      const requestedClaimable = url.searchParams.get('claimable');
      const claimable = requestedClaimable === 'true';

      if (status && !ACTION_STATUSES.includes(status)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_action_status' });
      }
      if (
        requestedClaimable
        && requestedClaimable !== 'true'
        && requestedClaimable !== 'false'
      ) {
        return sendJson(res, 400, { ok: false, error: 'invalid_claimable_filter' });
      }
      if (status && claimable) {
        return sendJson(res, 400, { ok: false, error: 'conflicting_action_filters' });
      }

      const actions = await store.listActions({ status, claimable, limit });
      return sendJson(res, 200, { count: actions.length, actions });
    }

    const actionItemRoute = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
    if (req.method === 'GET' && actionItemRoute) {
      if (!authorizeActionRead(req, res)) return;

      const actionId = decodeURIComponent(actionItemRoute[1]);
      const current = await store.getAction(actionId);
      if (!current) {
        return sendJson(res, 404, { ok: false, error: 'action_not_found' });
      }

      return sendJson(res, 200, { ok: true, action: current });
    }

    const operatorActionRoute = url.pathname.match(
      /^\/api\/actions\/([^/]+)\/(ignore|retry)$/,
    );
    if (req.method === 'POST' && operatorActionRoute) {
      if (!authorizeRefundRead(req, res)) return;

      const actionId = decodeURIComponent(operatorActionRoute[1]);
      const operation = operatorActionRoute[2];
      const { body } = await readRawJsonBody(req);

      const transition = operation === 'ignore'
        ? await store.ignoreAction(actionId, { reason: body.reason })
        : await store.retryAction(actionId);

      if (!transition.ok) {
        return sendJson(res, actionErrorStatus(transition.reason), {
          ok: false,
          error: transition.reason,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        idempotent: Boolean(transition.idempotent),
        action: transition.action,
      });
    }

    const actionRoute = url.pathname.match(
      /^\/api\/actions\/([^/]+)\/(claim|complete|fail)$/,
    );
    if (req.method === 'POST' && actionRoute) {
      if (!authorizeAction(req, res)) return;

      const actionId = decodeURIComponent(actionRoute[1]);
      const operation = actionRoute[2];
      const { body } = await readRawJsonBody(req);

      let transition;

      if (operation === 'claim') {
        transition = await store.claimAction(actionId, {
          leaseSeconds: body.leaseSeconds ?? 60,
        });
      } else if (operation === 'complete') {
        transition = await store.completeAction(actionId, {
          leaseToken: body.leaseToken,
        });
      } else {
        transition = await store.failAction(actionId, {
          leaseToken: body.leaseToken,
          error: body.error,
        });
      }

      if (!transition.ok) {
        return sendJson(res, actionErrorStatus(transition.reason), {
          ok: false,
          error: transition.reason,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        idempotent: Boolean(transition.idempotent),
        action: transition.action,
      });
    }

    if (
      req.method === 'POST'
      && (url.pathname === '/webhooks/roblox' || url.pathname === '/webhooks/roblox/refund')
    ) {
      const { rawBody, body } = await readRawJsonBody(req);

      const verification = verifyRobloxWebhook({
        header: req.headers['roblox-signature'],
        rawBody,
        secret: webhookSecret,
      });

      if (!verification.ok) {
        const status = verification.reason === 'expired_request' ? 403 : 401;
        return sendJson(res, status, { ok: false, error: verification.reason });
      }

      if (!validateEnvelope(body)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_webhook_envelope' });
      }

      if (body.EventType === 'SampleNotification') {
        return sendJson(res, 200, { ok: true, sample: true });
      }

      if (!isRefundEvent(body)) {
        return sendJson(res, 200, { ok: true, ignored: true });
      }

      const result = await store.ingestRefund(body);
      if (result.duplicate) {
        return sendJson(res, 200, { ok: true, duplicate: true });
      }

      return sendJson(res, 200, { ok: true, stored: true });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    }
    if (error?.message === 'body_too_large') {
      return sendJson(res, 413, { ok: false, error: 'body_too_large' });
    }

    console.error(error);
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Refund Management listening on 0.0.0.0:${port}`);
  console.log(
    `Storage mode: ${storage.mode} (refund=${storage.refundMode}, action=${storage.actionMode})`,
  );
});
