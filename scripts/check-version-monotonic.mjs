/**
 * @file scripts/check-version-monotonic.mjs
 *
 * Release guard, run before the release build. The version is counted from git
 * history (scripts/lib/releaseVersion.cjs), so this asserts:
 *
 *   - no tracked file has uncommitted changes: the build would ship them under
 *     HEAD's version, and that release could never be rebuilt from its commit;
 *   - the counted version is not LOWER than the highest release tag (vA.B.C.D).
 *     The Chrome Web Store rejects an upload that does not go up, and a build
 *     from an older branch would.
 *
 * Equal is allowed: rebuilding the release that is already tagged. Before the
 * first release tag there is nothing to compare against.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareChromeVersions } = require('./lib/manifestVersion.cjs');
const { readReleaseVersion, hasUncommittedChanges } = require('./lib/releaseVersion.cjs');
const pkg = require('../package.json');

const RELEASE_TAG = /^v\d+(?:\.\d+){0,3}$/;
const cwd = process.cwd();

function fail(message) {
  console.error(`Release version FAILED: ${message}`);
  process.exit(1);
}

let version;
try {
  version = readReleaseVersion({ cwd, packageVersion: pkg.version });
} catch (error) {
  fail(`cannot count the release version from git: ${error.message}`);
}

if (hasUncommittedChanges(cwd)) {
  fail(`tracked files have uncommitted changes, so the build would not be ${version} exactly. Commit or stash them first.`);
}

const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((tag) => RELEASE_TAG.test(tag));
const latestTag = tags.reduce(
  (latest, tag) => (latest && compareChromeVersions(latest.slice(1), tag.slice(1)) >= 0 ? latest : tag),
  null
);

if (latestTag && compareChromeVersions(version, latestTag.slice(1)) < 0) {
  fail(
    `${version} is lower than the latest release tag ${latestTag}. ` +
    'The Chrome Web Store rejects non-increasing versions — release from main, or from a branch that contains that release.'
  );
}

console.log(
  `Release version OK: ${version}` +
  (latestTag ? ` (latest release tag ${latestTag}).` : ' (no release tags yet).') +
  `\nAfter uploading, tag it: git tag -a v${version} -m "Release ${version}" && git push origin v${version}`
);
