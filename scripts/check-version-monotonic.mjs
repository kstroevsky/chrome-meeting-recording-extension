/**
 * @file scripts/check-version-monotonic.mjs
 *
 * Release guard: the Chrome Web Store rejects an upload whose version is not
 * strictly greater than the published one. Released versions are recorded as git
 * tags (created by `npm version`), so this asserts package.json's version is not
 * LOWER than the highest existing release tag — catching a forgotten bump or a
 * hand-edit to a non-increasing number before it reaches the store.
 *
 * Equal is allowed: that is the normal state right after `npm version` tags the
 * current release, and a clean rebuild of an already-released version. Outside a
 * git repo, or before the first tag, the check is skipped.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareChromeVersions } = require('./lib/manifestVersion.cjs');
const pkg = require('../package.json');

const SEMVER_TAG = /^v?\d+\.\d+\.\d+/;

let tags;
try {
  tags = execSync('git tag --sort=-v:refname', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  console.log('Version monotonicity: not a git repository (or git unavailable) — skipping.');
  process.exit(0);
}

const latestTag = tags
  .split('\n')
  .map((line) => line.trim())
  .find((line) => SEMVER_TAG.test(line));

if (!latestTag) {
  console.log(`Version monotonicity: no release tags yet — skipping (current ${pkg.version}).`);
  process.exit(0);
}

// Tags follow git's `v1.2.3` convention; strip the prefix to a bare version.
const latestVersion = latestTag.replace(/^v/, '');

if (compareChromeVersions(pkg.version, latestVersion) < 0) {
  console.error(
    `Version monotonicity FAILED: package.json ${pkg.version} is lower than the latest release tag ${latestTag}. ` +
    'The Chrome Web Store rejects non-increasing versions — bump with `npm version`.'
  );
  process.exit(1);
}

console.log(`Version monotonicity OK: package.json ${pkg.version} >= latest release tag ${latestTag}.`);
