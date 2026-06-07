import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('binds a direct recording shortcut for live activeTab capture', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../static/manifest.json', import.meta.url), 'utf8')
  );
  const startRecording = manifest.commands?.['start-recording'];

  assert.ok(startRecording, 'manifest must declare the start-recording command');
  assert.equal(startRecording.description, 'Start recording the active tab');
  assert.equal(startRecording.suggested_key?.default, 'Ctrl+Shift+9');
  assert.equal(startRecording.suggested_key?.mac, 'MacCtrl+Shift+9');
});
