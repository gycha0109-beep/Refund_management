import crypto from 'node:crypto';
import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ACTION_STATUSES,
  actionFromRefund,
  claimAction,
  completeAction,
  failAction,
  findCurrentAction,
  reduceActionJournal,
} from './actions.mjs';
import { verifyApiKey } from './auth.mjs';
import { resolveActionLogPath, resolveRefundLogPath } from './storage.mjs';
import { isRefundEvent, validateEnvelope, verifyRobloxWebhook } from './webhook.mjs';

const port = Number(process.env.PORT ?? 8787);
const webhookSecret = process.env.ROBLOX_WEBHOOK_SECRET ?? '';
const refundApiKey = process.env.REFUND_API_KEY ?? '';
const actionApiKey = process.env.ACTION_API_KEY ?? '';
const refundStorage = resolveRefundLogPath();
const actionStorage = resolveActionLogPath();
const refundLogPath = refundStorage.logPath;
const actionLogPath = actionStorage.logPath;

let actionMutation = Promise.resolve();

function withActionLock(fn) {
  const run = actionMutation.then(fn, fn);
  actionMutation = run.catch(() => {});
  return run;
}

async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonl(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readEvents() {
  return readJsonl(refundLogPath);
}

async function readActionJournal() {
  return readJsonl(actionLogPath);
}

async function ensureActionForRefund(refund) {
  return withActionLock(async () => {
    const journal = await readActionJournal();
    const existing = findCurrentAction(journal, refund.NotificationId);
    if (existing) return { created: false, action: existing };

    const action = actionFromRefund(refund);
    await appendJsonl(actionLogPath, action);
    return { created: true, action };
  });
}

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

function actionErrorStatus(reason) {
  if (reason === 'action_not_found') return 404;
  if (
    reason === 'action_already_leased'
    || reason === 'action_not_claimable'
    || reason === 'action_not_processing'
    || reason === 'lease_token_mismatch'
  ) {
    return 409;
  }
  return 400;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        service: 'refund-management',
        version: '0.4.0-alpha.1',
        endpoints: {
          health: '/health',
          webhook: '/webhooks/roblox',
          refunds: '/api/refunds?limit=20',
          actions: '/api/actions?status=PENDING&limit=20',
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
        storagePersistent: refundStorage.persistent,
        storageMode: refundStorage.mode,
        actionStoragePersistent: actionStorage.persistent,
        actionStorageMode: actionStorage.mode,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/refunds') {
      if (!authorizeRefundRead(req, res)) return;

      const requested = Number(url.searchParams.get('limit') ?? 20);
      const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 20, 100));
      const events = (await readEvents()).filter(isRefundEvent).slice(-limit).reverse();
      return sendJson(res, 200, { count: events.length, events });
    }

    if (req.method === 'GET' && url.pathname === '/api/actions') {
      if (!authorizeAction(req, res)) return;

      const requested = Number(url.searchParams.get('limit') ?? 20);
      const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 20, 100));
      const requestedStatus = url.searchParams.get('status');
      const status = requestedStatus?.toUpperCase() ?? null;

      if (status && !ACTION_STATUSES.includes(status)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_action_status' });
      }

      let actions = reduceActionJournal(await readActionJournal());
      if (status) {
        actions = actions.filter((action) => action.Status === status);
      }

      actions.sort((a, b) => String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)));
      actions = actions.slice(0, limit);

      return sendJson(res, 200, { count: actions.length, actions });
    }

    const actionRoute = url.pathname.match(/^\/api\/actions\/([^/]+)\/(claim|complete|fail)$/);
    if (req.method === 'POST' && actionRoute) {
      if (!authorizeAction(req, res)) return;

      const actionId = decodeURIComponent(actionRoute[1]);
      const operation = actionRoute[2];
      const { body } = await readRawJsonBody(req);

      return withActionLock(async () => {
        const journal = await readActionJournal();
        const current = findCurrentAction(journal, actionId);
        if (!current) {
          return sendJson(res, 404, { ok: false, error: 'action_not_found' });
        }

        let transition;

        if (operation === 'claim') {
          const requestedLeaseSeconds = Number(body.leaseSeconds ?? 60);
          const leaseMs = Number.isFinite(requestedLeaseSeconds)
            ? requestedLeaseSeconds * 1000
            : 60_000;
          transition = claimAction(current, {
            leaseToken: crypto.randomUUID(),
            leaseMs,
          });
        } else if (operation === 'complete') {
          transition = completeAction(current, {
            leaseToken: body.leaseToken,
          });
        } else {
          transition = failAction(current, {
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

        if (!transition.idempotent) {
          await appendJsonl(actionLogPath, transition.action);
        }

        return sendJson(res, 200, {
          ok: true,
          idempotent: Boolean(transition.idempotent),
          action: transition.action,
        });
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

      const existing = await readEvents();
      if (existing.some((event) => event.NotificationId === body.NotificationId)) {
        await ensureActionForRefund(body);
        return sendJson(res, 200, { ok: true, duplicate: true });
      }

      const storedEvent = { ...body, ReceivedAt: new Date().toISOString() };
      await appendJsonl(refundLogPath, storedEvent);
      await ensureActionForRefund(storedEvent);
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
  console.log(`Refund storage mode: ${refundStorage.mode} (persistent=${refundStorage.persistent})`);
  console.log(`Action storage mode: ${actionStorage.mode} (persistent=${actionStorage.persistent})`);
});
