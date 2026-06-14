import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toChromeManifestVersion } = require('../../scripts/lib/manifestVersion.cjs');
const pkg = require('../../package.json');

// Fast guards for the single-source-of-truth convention — these run in the unit
// tier (no build required), unlike the dist/ assertion in check-production-build.mjs.

test('static/manifest.json keeps the 0.0.0 placeholder (real version lives in package.json)', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../static/manifest.json', import.meta.url), 'utf8')
  );
  assert.equal(
    manifest.version,
    '0.0.0',
    'static/manifest.json version must stay the 0.0.0 placeholder; the build derives the real version from package.json'
  );
});

test('package.json version coerces to a legal Chrome manifest version', () => {
  assert.doesNotThrow(
    () => toChromeManifestVersion(pkg.version),
    `package.json version "${pkg.version}" must derive to a Chrome-legal manifest version`
  );
});
