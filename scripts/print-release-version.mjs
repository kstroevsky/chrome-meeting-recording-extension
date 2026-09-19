/**
 * @file scripts/print-release-version.mjs
 *
 * Prints the release version of the checked-out commit (a.b.c.d, counted from
 * git history — see scripts/lib/releaseVersion.cjs). Plain output, so it can be
 * used in a shell: git tag -a "v$(npm run -s release:version)".
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readReleaseVersion } = require('./lib/releaseVersion.cjs');
const pkg = require('../package.json');

try {
  console.log(readReleaseVersion({ cwd: process.cwd(), packageVersion: pkg.version }));
} catch (error) {
  console.error(`Cannot count the release version from git: ${error.message}`);
  process.exit(1);
}
