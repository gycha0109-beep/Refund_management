import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExpectedSignature } from '../src/webhook.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }

    await sleep(50);
  }

  throw new Error('server did not become ready');
}

test('HTTP server accepts a signed refund and protects refund reads', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refund-management-'));
  const logPath = path.join(tempDir, 'refunds.jsonl');
  const port = 18787;
  const webhookSecret = 'integration-webhook-secret';
  const refundApiKey = 'integration-api-key';

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ROBLOX_WEBHOOK_SECRET: webhookSecret,
      REFUND_API_KEY: refundApiKey,
      REFUND_LOG_PATH: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(`http://127.0.0.1:${port}/health`, child);

  const root = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(root.status, 200);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.webhookSecretConfigured, true);
  assert.equal(healthPayload.apiKeyConfigured, true);

  const body = {
    NotificationId: 'integration-n-1',
    EventType: 'TransactionRefunded',
    EventTime: new Date().toISOString(),
    EventPayload: {
      UserId: 123,
      ProductId: 456,
      RobuxAmount: 400,
      TransactionId: 'receipt-1',
    },
  };

  const rawBody = JSON.stringify(body, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = buildExpectedSignature({
    timestamp,
    rawBody,
    secret: webhookSecret,
  });

  const post = () => fetch(`http://127.0.0.1:${port}/webhooks/roblox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'roblox-signature': `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  });

  const first = await post();
  assert.equal(first.status, 200, stderr);
  assert.deepEqual(await first.json(), { ok: true, stored: true });

  const second = await post();
  assert.equal(second.status, 200, stderr);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });

  const noKey = await fetch(`http://127.0.0.1:${port}/api/refunds?limit=20`);
  assert.equal(noKey.status, 401);

  const wrongKey = await fetch(`http://127.0.0.1:${port}/api/refunds?limit=20`, {
    headers: { 'x-refund-api-key': 'wrong' },
  });
  assert.equal(wrongKey.status, 401);

  const refunds = await fetch(`http://127.0.0.1:${port}/api/refunds?limit=20`, {
    headers: { 'x-refund-api-key': refundApiKey },
  });
  assert.equal(refunds.status, 200);
  const refundPayload = await refunds.json();
  assert.equal(refundPayload.count, 1);
  assert.equal(refundPayload.events[0].NotificationId, body.NotificationId);

  const persisted = await readFile(logPath, 'utf8');
  assert.equal(persisted.trim().split('\n').length, 1);

  const tampered = await fetch(`http://127.0.0.1:${port}/webhooks/roblox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'roblox-signature': `t=${timestamp},v1=${signature}`,
    },
    body: JSON.stringify({ ...body, NotificationId: 'tampered' }),
  });
  assert.equal(tampered.status, 401);
});

test('refund reads return 503 when REFUND_API_KEY is not configured', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refund-management-unconfigured-'));
  const port = 18788;

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ROBLOX_WEBHOOK_SECRET: 'webhook-secret',
      REFUND_API_KEY: '',
      REFUND_LOG_PATH: path.join(tempDir, 'refunds.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(`http://127.0.0.1:${port}/health`, child);

  const response = await fetch(`http://127.0.0.1:${port}/api/refunds`, {
    headers: { 'x-refund-api-key': 'anything' },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'api_key_not_configured',
  });
});
