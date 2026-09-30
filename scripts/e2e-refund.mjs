import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildExpectedSignature } from '../src/webhook.mjs';

const PROD_HOST = 'refundmanagement-production.up.railway.app';

export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('E2E_BASE_URL is required');

  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('E2E_BASE_URL must use http or https');
  }

  if (url.hostname.toLowerCase() === PROD_HOST) {
    throw new Error('refusing to run E2E against the production backend');
  }

  return url.toString().replace(/\/$/, '');
}

export function buildRefundEvent({
  notificationId,
  transactionId,
  userId,
  productId,
  robuxAmount = 400,
  eventTime = new Date().toISOString(),
}) {
  if (!notificationId) throw new Error('notificationId is required');
  if (!transactionId) throw new Error('transactionId is required');

  const parsedUserId = Number(userId);
  const parsedProductId = Number(productId);
  const parsedRobuxAmount = Number(robuxAmount);

  if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error('userId must be a positive integer');
  }
  if (!Number.isSafeInteger(parsedProductId) || parsedProductId <= 0) {
    throw new Error('productId must be a positive integer');
  }
  if (!Number.isFinite(parsedRobuxAmount) || parsedRobuxAmount < 0) {
    throw new Error('robuxAmount must be a non-negative number');
  }

  return {
    NotificationId: String(notificationId),
    EventType: 'TransactionRefunded',
    EventTime: eventTime,
    EventPayload: {
      UserId: parsedUserId,
      ProductId: parsedProductId,
      RobuxAmount: parsedRobuxAmount,
      TransactionId: String(transactionId),
    },
  };
}

export function signRefundBody({
  body,
  secret,
  timestamp = String(Math.floor(Date.now() / 1000)),
}) {
  if (!secret) throw new Error('E2E_WEBHOOK_SECRET is required');

  const rawBody = JSON.stringify(body);
  const signature = buildExpectedSignature({ timestamp, rawBody, secret });

  return {
    rawBody,
    header: `t=${timestamp},v1=${signature}`,
  };
}

export async function sendRefund({ baseUrl, secret, event, fetchImpl = fetch }) {
  const normalized = normalizeBaseUrl(baseUrl);
  const { rawBody, header } = signRefundBody({ body: event, secret });

  const response = await fetchImpl(`${normalized}/webhooks/roblox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'roblox-signature': header,
    },
    body: rawBody,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`webhook failed: HTTP ${response.status} ${payload.error ?? ''}`.trim());
  }

  return payload;
}

export async function getAction({
  baseUrl,
  actionApiKey,
  actionId,
  fetchImpl = fetch,
}) {
  if (!actionApiKey) throw new Error('E2E_ACTION_API_KEY is required');

  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(
    `${normalized}/api/actions/${encodeURIComponent(actionId)}`,
    { headers: { 'x-action-api-key': actionApiKey } },
  );

  if (response.status === 404) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`action read failed: HTTP ${response.status} ${payload.error ?? ''}`.trim());
  }

  return payload.action;
}

export async function waitForTerminalAction({
  baseUrl,
  actionApiKey,
  actionId,
  timeoutMs = 60_000,
  pollMs = 1_000,
  fetchImpl = fetch,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const action = await getAction({ baseUrl, actionApiKey, actionId, fetchImpl });

    if (action && ['APPLIED', 'FAILED', 'IGNORED'].includes(action.Status)) {
      return action;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`timed out waiting for terminal action: ${actionId}`);
}

function argValue(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main() {
  if (process.env.E2E_CONFIRM !== 'YES') {
    throw new Error('set E2E_CONFIRM=YES to send a synthetic refund');
  }

  const baseUrl = normalizeBaseUrl(process.env.E2E_BASE_URL);
  const secret = process.env.E2E_WEBHOOK_SECRET;
  const actionApiKey = process.env.E2E_ACTION_API_KEY;

  const suffix = crypto.randomUUID();
  const notificationId = argValue('notification-id', `e2e-refund-${suffix}`);
  const transactionId = argValue('transaction-id', `e2e-tx-${suffix}`);
  const userId = argValue('user-id', process.env.E2E_USER_ID ?? '123456789');
  const productId = argValue('product-id', process.env.E2E_PRODUCT_ID ?? '987654321');
  const robuxAmount = argValue('robux', process.env.E2E_ROBUX_AMOUNT ?? '400');

  const event = buildRefundEvent({
    notificationId,
    transactionId,
    userId,
    productId,
    robuxAmount,
  });

  const result = await sendRefund({ baseUrl, secret, event });

  process.stdout.write(
    `E2E refund accepted: notification=${notificationId} stored=${Boolean(result.stored)} duplicate=${Boolean(result.duplicate)}\n`,
  );

  if (process.argv.includes('--wait')) {
    const action = await waitForTerminalAction({
      baseUrl,
      actionApiKey,
      actionId: notificationId,
      timeoutMs: Number(process.env.E2E_TIMEOUT_MS ?? 60_000),
      pollMs: Number(process.env.E2E_POLL_MS ?? 1_000),
    });

    process.stdout.write(
      `E2E action terminal: status=${action.Status} attempt=${action.Attempt} action=${action.ActionId}\n`,
    );

    if (action.Status !== 'APPLIED') process.exitCode = 2;
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
