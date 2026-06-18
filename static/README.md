# Static — HTML entry pages & the source manifest

> Assets webpack copies into the build: the HTML entry pages and the **source** `manifest.json`. The critical thing here is that **`manifest.json` is transformed at build time** — what's on disk is a template with placeholders, not what ships. Don't hand-edit the parts the build owns.

## HTML entry pages

Each pairs with a `src/` entrypoint (webpack bundles the `.ts`, this provides the page that loads it):

| Page | Entry | Surface |
| :--- | :--- | :--- |
| `popup.html` | `src/popup.ts` | the browser-action control panel |
| `settings.html` | `src/settings.ts` | the settings page |
| `debug.html` | `src/debug.ts` | the diagnostics dashboard (dev only) |
| `offscreen.html` | `src/offscreen.ts` | the offscreen recording runtime |
| `micsetup.html` / `camsetup.html` | `src/micsetup.ts` / `src/camsetup.ts` | the mic/camera permission-priming pages |

## The manifest is built, not shipped as-is

`static/manifest.json` is the **source**; `webpack.config.js`'s `transformManifest` produces the shipped manifest. What it changes (so don't hand-edit these):

- **`version` is derived from `package.json`** — `toChromeManifestVersion(pkg.version)`. The `"0.0.0"` in the source is an **ignored placeholder**. `version_name` is the full semver (`+ " (dev)"` in dev). Never bump the manifest version by hand — bump `package.json` (`npm version`); see the [versioning protocol](../docs/plans/).
- **`oauth2.client_id`** is injected from the build env for the Chrome target; for non-Chrome targets the whole `oauth2` block **and** the dev `key` are **deleted** (those browsers authenticate via `launchWebAuthFlow` — [ADR-0002](../docs/adr/0002-cross-browser-support-strategy.md)).
- **`system.cpu` is pushed into `permissions` for dev builds only.** It powers dev-only system-wide CPU sampling; production never ships it, keeping the store listing's permission set minimal and avoiding a permission re-review prompt. **It is not in this source file** — the transform adds it, so don't add it here expecting prod behavior.

**Standing rule:** the build is the source of truth for the shipped manifest. Treat the version, the `oauth2` block, and dev-only permissions as build-owned — editing them in `static/manifest.json` either does nothing (version) or risks shipping a dev-only permission.

## Related

- `webpack.config.js` (`transformManifest`) — the transform itself.
- [`platform/capabilities`](../src/platform/capabilities/README.md) — why `oauth2` is Chrome-only (the auth seam / ADR-0002).
- [`scripts/`](../scripts/README.md) — `check-production-build` guards that no dev-only bits leak into a production bundle.
