import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtime = await readFile('roblox/RobuxBacktrackServer.lua', 'utf8');
const fixture = await readFile('roblox/e2e/E2EFixture.lua', 'utf8');
const bootstrap = await readFile('roblox/e2e/E2EBootstrap.server.lua', 'utf8');

test('ACK-loss fault injection is Studio-only and happens before backend completion', () => {
  assert.match(runtime, /TestFault is only allowed in Roblox Studio/);
  const appliedMarker = runtime.indexOf('"APPLIED"');
  const fault = runtime.indexOf('AFTER_HANDLER_BEFORE_COMPLETE');
  const completion = runtime.lastIndexOf('return completeRemote(action)');
  assert.ok(appliedMarker >= 0);
  assert.ok(fault > appliedMarker);
  assert.ok(completion > fault);
});

test('E2E sample mutation is idempotent by ActionId', () => {
  assert.match(fixture, /AppliedActions\[actionId\]/);
  assert.match(fixture, /current\.Gems -= Fixture\.RefundGems/);
  assert.match(fixture, /current\.HandlerExecutions \+= 1/);
  assert.match(fixture, /RunService:IsStudio\(\)/);
});

test('E2E bootstrap uses short leases and exposes the ACK-loss fault mode', () => {
  assert.match(bootstrap, /LeaseSeconds = 15/);
  assert.match(bootstrap, /PollIntervalSeconds = 5/);
  assert.match(bootstrap, /TestFault = faultMode/);
});
