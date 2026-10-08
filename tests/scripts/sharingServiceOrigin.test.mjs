import assert from 'node:assert/strict';
import test from 'node:test';
import sharing from '../../scripts/lib/sharingServiceOrigin.cjs';

const { normalizeSharingServiceOrigin, sharingHostPermission } = sharing;

test('normalizes the configured sharing origin and derives host permission', () => {
  assert.equal(normalizeSharingServiceOrigin(' https://sharing.example '), 'https://sharing.example');
  assert.equal(sharingHostPermission('https://sharing.example'), 'https://sharing.example/*');
  assert.equal(sharingHostPermission(''), null);
});

test('rejects paths, credentials, queries and insecure origins', () => {
  for (const value of [
    'http://sharing.example',
    'https://sharing.example/api',
    'https://user:secret@sharing.example',
    'https://sharing.example/?x=1',
  ]) {
    assert.throws(() => normalizeSharingServiceOrigin(value), /SHARING_SERVICE_ORIGIN/);
  }
});
