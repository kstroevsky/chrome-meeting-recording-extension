'use strict';

/**
 * @file scripts/lib/manifestTargets.cjs
 *
 * Per-browser-target manifest profiles (ADR-0002). Cross-browser manifest
 * decisions are modeled by browser *family* + auth *capability* rather than by
 * "is it chrome", because two independent concerns were previously conflated:
 *
 *   - `oauth2` is configuration for chrome.identity.getAuthToken (Chrome-only),
 *     so it is kept only for the `chrome-identity` auth capability.
 *   - `key` pins a stable extension id. Every Chromium browser authenticates via
 *     launchWebAuthFlow against a `https://<id>.chromiumapp.org/` redirect that
 *     must match a registered URI, so the whole Chromium family must keep `key`.
 *     Dropping it (the old "non-chrome" branch) made the id unstable and caused
 *     `redirect_uri_mismatch`.
 *
 * Adding Firefox/Safari later is a new profile with a different `family`; the
 * applier needs no new branches.
 */

const TARGET_PROFILES = {
  chrome: { family: 'chromium', auth: 'chrome-identity', stableKey: true },
  edge: { family: 'chromium', auth: 'web-auth-flow', stableKey: true },
  brave: { family: 'chromium', auth: 'web-auth-flow', stableKey: true },
  opera: { family: 'chromium', auth: 'web-auth-flow', stableKey: true },
  vivaldi: { family: 'chromium', auth: 'web-auth-flow', stableKey: true },
  arc: { family: 'chromium', auth: 'web-auth-flow', stableKey: true },
};

const DEFAULT_TARGET = 'chrome';

function getTargetProfile(target) {
  const profile = TARGET_PROFILES[target];
  if (!profile) {
    throw new Error(
      `No manifest profile for build target "${target}". Known targets: ${Object.keys(TARGET_PROFILES).join(', ')}`
    );
  }
  return profile;
}

/** True for targets that authenticate via launchWebAuthFlow (need the web OAuth client). */
function usesWebAuthFlow(target) {
  return getTargetProfile(target).auth === 'web-auth-flow';
}

/**
 * Apply a target's profile to a parsed manifest object (mutates and returns it).
 *
 * @param {object} manifest parsed manifest.json
 * @param {string} target build-target key
 * @param {{ oauthClientId?: string }} [opts]
 * @returns {object} the same manifest, mutated
 */
function applyTargetToManifest(manifest, target, opts = {}) {
  const profile = getTargetProfile(target);

  // oauth2 is getAuthToken (chrome-identity) config; keep only there.
  if (profile.auth === 'chrome-identity') {
    if (!manifest.oauth2 || typeof manifest.oauth2 !== 'object') {
      throw new Error('manifest.json is missing oauth2 configuration for a chrome-identity target');
    }
    manifest.oauth2.client_id = opts.oauthClientId;
  } else {
    delete manifest.oauth2;
  }

  // `key` pins the extension id; keep it wherever the family needs a stable id
  // for the OAuth redirect. Only families that don't use it drop it.
  if (!profile.stableKey) {
    delete manifest.key;
  }

  return manifest;
}

module.exports = {
  TARGET_PROFILES,
  DEFAULT_TARGET,
  getTargetProfile,
  usesWebAuthFlow,
  applyTargetToManifest,
};
