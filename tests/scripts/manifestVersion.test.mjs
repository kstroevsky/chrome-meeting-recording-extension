import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toChromeManifestVersion, compareChromeVersions } = require('../../scripts/lib/manifestVersion.cjs');

test('passes through a clean numeric version', () => {
  assert.equal(toChromeManifestVersion('1.4.2'), '1.4.2');
  assert.equal(toChromeManifestVersion('0.0.0'), '0.0.0');
  assert.equal(toChromeManifestVersion('12'), '12');
  assert.equal(toChromeManifestVersion('1.2.3.4'), '1.2.3.4');
});

test('strips semver pre-release and build metadata', () => {
  assert.equal(toChromeManifestVersion('1.4.2-beta.3'), '1.4.2');
  assert.equal(toChromeManifestVersion('1.4.2+ci.7'), '1.4.2');
  assert.equal(toChromeManifestVersion('1.4.2-rc.1+exp.sha.5114f85'), '1.4.2');
});

test('caps at four segments (Chrome maximum)', () => {
  assert.equal(toChromeManifestVersion('1.2.3.4.5'), '1.2.3.4');
});

test('trims surrounding whitespace', () => {
  assert.equal(toChromeManifestVersion('  2.0.1  '), '2.0.1');
});

test('rejects versions with no numeric core', () => {
  assert.throws(() => toChromeManifestVersion('v1.2.3'), /numeric core/);
  assert.throws(() => toChromeManifestVersion('beta'), /numeric core/);
  assert.throws(() => toChromeManifestVersion(''), /numeric core/);
  assert.throws(() => toChromeManifestVersion(null), /numeric core/);
});

test('rejects a segment above the 65535 ceiling', () => {
  assert.throws(() => toChromeManifestVersion('1.70000.0'), /65535 range/);
});

test('compareChromeVersions orders numerically, not lexically', () => {
  assert.equal(compareChromeVersions('1.2.0', '1.1.0'), 1);
  assert.equal(compareChromeVersions('1.1.0', '1.2.0'), -1);
  assert.equal(compareChromeVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareChromeVersions('1.10.0', '1.9.0'), 1); // not "1.10" < "1.9"
  assert.equal(compareChromeVersions('2.0.0', '1.9.9'), 1);
});

test('compareChromeVersions pads missing segments and strips pre-release', () => {
  assert.equal(compareChromeVersions('1.2', '1.2.0'), 0);
  assert.equal(compareChromeVersions('1.2.0.0', '1.2'), 0);
  assert.equal(compareChromeVersions('1.2.0-beta.1', '1.2.0'), 0);
});
