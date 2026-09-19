/**
 * @file scripts/install-git-hooks.mjs
 *
 * Installs the commit-msg hook that checks commit prefixes (they decide the
 * release version). Runs on `npm install` via `prepare`, and by hand with
 * `npm run hooks:install`.
 *
 * It writes into the repository's own hooks directory rather than pointing
 * core.hooksPath at a tracked folder, so hooks already there (CodeGraph's
 * post-commit) keep running. A commit-msg hook it did not write is left alone.
 * It never fails: an install outside a git checkout just has nothing to do.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'scripts/check-commit-message.mjs';
const HOOK = `#!/bin/sh
# Installed by scripts/install-git-hooks.mjs: the commit prefix decides the release version.
command -v node >/dev/null 2>&1 || exit 0
exec node "$(git rev-parse --show-toplevel)/${MARKER}" "$1"
`;

try {
  const cwd = process.cwd();
  const hooksDir = path.resolve(
    cwd,
    execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  );
  const hookPath = path.join(hooksDir, 'commit-msg');
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : null;
  if (existing !== null && !existing.includes(MARKER)) {
    console.warn(`[hooks] ${hookPath} already exists and was not installed by this project; leaving it as is.`);
  } else if (existing !== HOOK) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, HOOK, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755);
    console.log(`[hooks] installed the commit-msg prefix check at ${hookPath}`);
  }
} catch {
  // Not a git checkout (or git is missing): there is no hook to install.
}
