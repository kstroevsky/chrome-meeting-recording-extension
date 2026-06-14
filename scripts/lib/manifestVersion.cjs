'use strict';

/**
 * @file scripts/lib/manifestVersion.cjs
 *
 * Single source of truth for the extension version is package.json. The Chrome /
 * Edge manifest `version` is *derived* from it at build time so the two can never
 * drift. Chrome requires 1–4 dot-separated integers (each 0–65535) and rejects
 * semver pre-release / build suffixes, so this coerces:
 *   "1.4.2"        -> "1.4.2"
 *   "1.4.2-beta.3" -> "1.4.2"   (full string is kept in manifest.version_name)
 *   "1.4.2+ci.7"   -> "1.4.2"
 *
 * Shared (CommonJS) so webpack.config.js can `require` it and the node:test suite
 * can exercise it directly.
 */

const MAX_SEGMENT = 65535;

/**
 * @param {unknown} semver npm/package.json version string
 * @returns {string} a Chrome-legal manifest version (numeric, 1–4 segments)
 */
function toChromeManifestVersion(semver) {
  const raw = String(semver == null ? '' : semver).trim();
  const core = raw.match(/^\d+(?:\.\d+){0,3}/);
  if (!core) {
    throw new Error(
      `Cannot derive a Chrome manifest version from "${raw}": expected a leading numeric core like 1.2.3`
    );
  }
  const version = core[0];
  for (const segment of version.split('.')) {
    const value = Number(segment);
    if (!Number.isInteger(value) || value < 0 || value > MAX_SEGMENT) {
      throw new Error(
        `Manifest version segment "${segment}" in "${raw}" is outside Chrome's 0–${MAX_SEGMENT} range`
      );
    }
  }
  return version;
}

/**
 * Numerically compare two versions by their Chrome-legal cores (pre-release tags
 * stripped, missing trailing segments treated as 0). Numeric, not lexical, so
 * 1.10.0 > 1.9.0.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1} sign of (a - b)
 */
function compareChromeVersions(a, b) {
  const pa = toChromeManifestVersion(a).split('.').map(Number);
  const pb = toChromeManifestVersion(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { toChromeManifestVersion, compareChromeVersions, MAX_SEGMENT };
