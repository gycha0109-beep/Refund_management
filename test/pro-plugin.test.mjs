import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('plugin/RobuxBacktrackPro.plugin.lua', 'utf8');

test('Pro plugin never embeds a backend URL or action key value', () => {
  assert.equal(source.includes('refundmanagement-production.up.railway.app'), false);
  assert.equal(source.includes('ACTION_API_KEY='), false);
  assert.match(source, /DEFAULT_SECRET_NAME = "RobuxBacktrackActionKey"/);
});

test('Pro installer preserves product handlers and uses ScriptEditorService', () => {
  assert.match(source, /ScriptEditorService:UpdateSourceAsync/);
  assert.match(source, /ROBUX_BACKTRACK_HANDLERS_START/);
  assert.match(source, /ROBUX_BACKTRACK_HANDLERS_END/);
  assert.match(source, /refusing to overwrite developer code/);
  assert.match(source, /handler_not_implemented/);
});

test('Pro plugin installs only server-side runtime containers', () => {
  assert.match(source, /ServerScriptService/);
  assert.match(source, /RobuxBacktrackServer/);
  assert.match(source, /ProductHandlers/);
  assert.match(source, /Bootstrap/);
  assert.equal(source.includes('ReplicatedStorage'), false);
  assert.equal(source.includes('LocalScript'), false);
});
