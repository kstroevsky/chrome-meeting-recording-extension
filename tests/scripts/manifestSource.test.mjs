import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

// Fast guards for the single-source-of-truth convention — these run in the unit
// tier (no build required), unlike the dist/ assertion in check-production-build.mjs.

test('static/manifest.json keeps the 0.0.0 placeholder (real version is counted from git)', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../../static/manifest.json', import.meta.url), 'utf8')
  );
  assert.equal(
    manifest.version,
    '0.0.0',
    'static/manifest.json version must stay the 0.0.0 placeholder; the build counts the real version from git'
  );
});

test('package.json version carries only the major; the rest is counted from git', () => {
  assert.match(
    pkg.version,
    /^\d+\.0\.0$/,
    `package.json version "${pkg.version}" must be <major>.0.0 — b.c.d are counted from git history, so bumping them here does nothing`
  );
});
