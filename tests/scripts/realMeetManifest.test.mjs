import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('binds an extension action shortcut for live activeTab capture', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../static/manifest.json', import.meta.url), 'utf8')
  );
  const executeAction = manifest.commands?._execute_action;

  assert.ok(executeAction, 'manifest must declare the _execute_action command');
  assert.equal(executeAction.suggested_key?.default, 'Ctrl+Shift+9');
  assert.equal(executeAction.suggested_key?.mac, 'MacCtrl+Shift+9');
});
