/**
 * @file scripts/check-commit-message.mjs
 *
 * The commit-msg hook (installed by scripts/install-git-hooks.mjs). A commit's
 * prefix decides the release version, so a subject without a known prefix is
 * refused rather than silently counting as nothing.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commitMessageProblem } = require('./lib/releaseVersion.cjs');

const problem = commitMessageProblem(fs.readFileSync(process.argv[2], 'utf8'));
if (problem) {
  console.error(problem);
  process.exit(1);
}
