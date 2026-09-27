import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyApiKey } from './auth.mjs';
import { isRefundEvent, validateEnvelope, verifyRobloxWebhook } from './webhook.mjs';

const port = Number(process.env.PORT ?? 8787);
const webhookSecret = process.env.ROBLOX_WEBHOOK_SECRET ?? '';
const refundApiKey = process.env.REFUND_API_KEY ?? '';
const logPath = path.resolve(process.env.REFUND_LOG_PATH ?? './data/refunds.jsonl');

async function readEvents() {
  try {
    const text = await readFile(logPath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendEvent(event) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8');
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

function authorizeRefundRead(req, res) {
  const verification = verifyApiKey({
    provided: req.headers['x-refund-api-key'],
    expected: refundApiKey,
  });

  if (verification.ok) return true;

  if (verification.reason === 'api_key_not_configured') {
    sendJson(res, 503, { ok: false, error: verification.reason });
    return false;
  }

  sendJson(res, 401, { ok: false, error: verification.reason });
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        service: 'refund-management',
        version: '0.2.0',
        endpoints: {
          health: '/health',
          webhook: '/webhooks/roblox',
          refunds: '/api/refunds?limit=20',
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'refund-management',
        webhookSecretConfigured: Boolean(webhookSecret),
        apiKeyConfigured: Boolean(refundApiKey),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/refunds') {
      if (!authorizeRefundRead(req, res)) return;

      const requested = Number(url.searchParams.get('limit') ?? 20);
      const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 20, 100));
      const events = (await readEvents()).filter(isRefundEvent).slice(-limit).reverse();
      return sendJson(res, 200, { count: events.length, events });
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

      // Creator Hub's Test Response sends SampleNotification. Accept it without storing it.
      if (body.EventType === 'SampleNotification') {
        return sendJson(res, 200, { ok: true, sample: true });
      }

      if (!isRefundEvent(body)) {
        return sendJson(res, 200, { ok: true, ignored: true });
      }

      const existing = await readEvents();
      if (existing.some((event) => event.NotificationId === body.NotificationId)) {
        return sendJson(res, 200, { ok: true, duplicate: true });
      }

      await appendEvent({ ...body, ReceivedAt: new Date().toISOString() });
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
});
