import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TARGET_PROFILES, getTargetProfile, usesWebAuthFlow, applyTargetToManifest } = require('../../scripts/lib/manifestTargets.cjs');

function baseManifest() {
  return {
    key: 'BASE64-KEY-DATA',
    oauth2: { client_id: '__GOOGLE_OAUTH_CLIENT_ID__', scopes: ['https://www.googleapis.com/auth/drive.file'] },
    permissions: ['identity'],
  };
}

test('chrome keeps oauth2 (with the injected client id) and keeps key', () => {
  const m = applyTargetToManifest(baseManifest(), 'chrome', { oauthClientId: 'cid.apps.googleusercontent.com' });
  assert.equal(m.oauth2.client_id, 'cid.apps.googleusercontent.com');
  assert.ok(m.key, 'chrome keeps key');
});

test('non-Chrome Chromium targets strip oauth2 but KEEP key (the redirect_uri fix)', () => {
  for (const target of ['edge', 'brave', 'opera', 'vivaldi', 'arc']) {
    const m = applyTargetToManifest(baseManifest(), target, {});
    assert.equal(m.oauth2, undefined, `${target} strips the getAuthToken oauth2 block`);
    assert.ok(m.key, `${target} must keep key so the chromiumapp.org redirect stays stable`);
  }
});

test('usesWebAuthFlow: false for chrome, true for the rest of the Chromium family', () => {
  assert.equal(usesWebAuthFlow('chrome'), false);
  for (const target of ['edge', 'brave', 'opera', 'vivaldi', 'arc']) {
    assert.equal(usesWebAuthFlow(target), true, target);
  }
});

test('every known target is the chromium family this round', () => {
  for (const [target, profile] of Object.entries(TARGET_PROFILES)) {
    assert.equal(profile.family, 'chromium', target);
  }
});

test('an unknown target throws', () => {
  assert.throws(() => getTargetProfile('netscape'), /No manifest profile/);
});

test('a chrome-identity target missing oauth2 throws', () => {
  assert.throws(
    () => applyTargetToManifest({ permissions: [] }, 'chrome', { oauthClientId: 'x' }),
    /missing oauth2/
  );
});
