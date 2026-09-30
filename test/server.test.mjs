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

test('HTTP server accepts a signed refund and exposes a leased action queue', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refund-management-'));
  const refundLogPath = path.join(tempDir, 'refunds.jsonl');
  const actionLogPath = path.join(tempDir, 'actions.jsonl');
  const port = 18787;
  const webhookSecret = 'integration-webhook-secret';
  const refundApiKey = 'integration-api-key';
  const actionApiKey = 'integration-action-key';

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ROBLOX_WEBHOOK_SECRET: webhookSecret,
      REFUND_API_KEY: refundApiKey,
      ACTION_API_KEY: actionApiKey,
      REFUND_LOG_PATH: refundLogPath,
      ACTION_LOG_PATH: actionLogPath,
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
  assert.equal(healthPayload.actionApiKeyConfigured, true);

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

  const actionNoKey = await fetch(`http://127.0.0.1:${port}/api/actions`);
  assert.equal(actionNoKey.status, 401);

  const pending = await fetch(`http://127.0.0.1:${port}/api/actions?status=PENDING`, {
    headers: { 'x-action-api-key': actionApiKey },
  });
  assert.equal(pending.status, 200);
  const pendingPayload = await pending.json();
  assert.equal(pendingPayload.count, 1);
  assert.equal(pendingPayload.actions[0].ActionId, body.NotificationId);
  assert.equal(pendingPayload.actions[0].Status, 'PENDING');

  const claimableBefore = await fetch(
    `http://127.0.0.1:${port}/api/actions?claimable=true`,
    { headers: { 'x-action-api-key': actionApiKey } },
  );
  assert.equal(claimableBefore.status, 200);
  assert.equal((await claimableBefore.json()).count, 1);

  const claim = await fetch(
    `http://127.0.0.1:${port}/api/actions/${body.NotificationId}/claim`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-api-key': actionApiKey,
      },
      body: JSON.stringify({ leaseSeconds: 60 }),
    },
  );
  assert.equal(claim.status, 200);
  const claimPayload = await claim.json();
  assert.equal(claimPayload.action.Status, 'PROCESSING');
  assert.equal(claimPayload.action.Attempt, 1);
  assert.equal(typeof claimPayload.action.LeaseToken, 'string');

  const claimableDuringLease = await fetch(
    `http://127.0.0.1:${port}/api/actions?claimable=true`,
    { headers: { 'x-action-api-key': actionApiKey } },
  );
  assert.equal(claimableDuringLease.status, 200);
  assert.equal((await claimableDuringLease.json()).count, 0);

  const duplicateClaim = await fetch(
    `http://127.0.0.1:${port}/api/actions/${body.NotificationId}/claim`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-api-key': actionApiKey,
      },
      body: '{}',
    },
  );
  assert.equal(duplicateClaim.status, 409);
  assert.equal((await duplicateClaim.json()).error, 'action_already_leased');

  const wrongComplete = await fetch(
    `http://127.0.0.1:${port}/api/actions/${body.NotificationId}/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-api-key': actionApiKey,
      },
      body: JSON.stringify({ leaseToken: 'wrong' }),
    },
  );
  assert.equal(wrongComplete.status, 409);

  const complete = await fetch(
    `http://127.0.0.1:${port}/api/actions/${body.NotificationId}/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-api-key': actionApiKey,
      },
      body: JSON.stringify({ leaseToken: claimPayload.action.LeaseToken }),
    },
  );
  assert.equal(complete.status, 200);
  const completePayload = await complete.json();
  assert.equal(completePayload.action.Status, 'APPLIED');
  assert.equal(completePayload.idempotent, false);

  const completeReplay = await fetch(
    `http://127.0.0.1:${port}/api/actions/${body.NotificationId}/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-action-api-key': actionApiKey,
      },
      body: JSON.stringify({ leaseToken: claimPayload.action.LeaseToken }),
    },
  );
  assert.equal(completeReplay.status, 200);
  assert.equal((await completeReplay.json()).idempotent, true);

  const persistedRefunds = await readFile(refundLogPath, 'utf8');
  assert.equal(persistedRefunds.trim().split('\n').length, 1);

  const persistedActions = await readFile(actionLogPath, 'utf8');
  assert.equal(persistedActions.trim().split('\n').length, 3);

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

test('protected APIs return 503 when their server keys are not configured', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refund-management-unconfigured-'));
  const port = 18788;

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      ROBLOX_WEBHOOK_SECRET: 'webhook-secret',
      REFUND_API_KEY: '',
      ACTION_API_KEY: '',
      REFUND_LOG_PATH: path.join(tempDir, 'refunds.jsonl'),
      ACTION_LOG_PATH: path.join(tempDir, 'actions.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(`http://127.0.0.1:${port}/health`, child);

  const refunds = await fetch(`http://127.0.0.1:${port}/api/refunds`, {
    headers: { 'x-refund-api-key': 'anything' },
  });
  assert.equal(refunds.status, 503);
  assert.deepEqual(await refunds.json(), {
    ok: false,
    error: 'api_key_not_configured',
  });

  const actions = await fetch(`http://127.0.0.1:${port}/api/actions`, {
    headers: { 'x-action-api-key': 'anything' },
  });
  assert.equal(actions.status, 503);
  assert.deepEqual(await actions.json(), {
    ok: false,
    error: 'api_key_not_configured',
  });
});
