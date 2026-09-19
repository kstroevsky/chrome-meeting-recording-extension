# Static — HTML entry pages & the source manifest

> Assets webpack copies into the build: the HTML entry pages and the **source** `manifest.json`. The critical thing here is that **`manifest.json` is transformed at build time** — what's on disk is a template with placeholders, not what ships. Don't hand-edit the parts the build owns.

## HTML entry pages

Each pairs with a `src/` entrypoint (webpack bundles the `.ts`, this provides the page that loads it):

| Page | Entry | Surface |
| :--- | :--- | :--- |
| `popup.html` | `src/popup.ts` | the browser-action control panel |
| `recordings.html` | `src/recordings.ts` | paginated durable recording history (local downloads and Drive links) |
| `settings.html` | `src/settings.ts` | recorder settings plus the live anonymous-diagnostics opt-out and disclosure |
| `debug.html` | `src/debug.ts` | the diagnostics dashboard (dev only) |
| `offscreen.html` | `src/offscreen.ts` | the offscreen recording runtime |
| `micsetup.html` / `camsetup.html` | `src/micsetup.ts` / `src/camsetup.ts` | the mic/camera permission-priming pages |

## The manifest is built, not shipped as-is

`static/manifest.json` is the **source**; `webpack.config.js`'s `transformManifest` produces the shipped manifest. What it changes (so don't hand-edit these):

- **`version` is counted from git history** — `a.b.c.d` from `scripts/lib/releaseVersion.cjs`, where only `a` comes from `package.json`. The `"0.0.0"` in the source is an **ignored placeholder**. `version_name` adds what makes the build differ from its commit (`(dev)`, `(uncommitted changes)`). Never set the version by hand; see [Versioning and releasing](../README.md#versioning-and-releasing).
- **`oauth2.client_id`** is injected from the build env for the Chrome target. The other supported Chromium targets authenticate via `launchWebAuthFlow`, so their emitted manifests drop `oauth2` but **keep** the stable `key`: its extension id is part of the registered redirect URI. Firefox is intentionally not a build target yet; see [ADR-0002](../docs/adr/0002-cross-browser-support-strategy.md).
- **`system.cpu` is pushed into `permissions` for dev builds only.** It powers dev-only system-wide CPU sampling; production never ships it, keeping the store listing's permission set minimal and avoiding a permission re-review prompt. **It is not in this source file** — the transform adds it, so don't add it here expecting prod behavior.
- **The telemetry Worker origin is injected into `host_permissions` from `TELEMETRY_ENDPOINT`.** Production builds fail unless it is an exact HTTPS `/api/telemetry/batches` URL. The source manifest contains no placeholder host, so an invalid endpoint cannot silently broaden network access.

**Standing rule:** the build is the source of truth for the shipped manifest. Treat the version, target-specific `oauth2` handling, telemetry host permission, the stable `key`, and dev-only permissions as build-owned — editing them in `static/manifest.json` either does nothing (version) or risks breaking OAuth or shipping a dev-only permission.

## Assets and styling

`styles/` contains page-scoped CSS, including the split popup layers (`base`, `config`, `recording`, and `after`) and the dedicated recordings, settings, and diagnostics sheets. `fonts/manrope-variable.woff2` is bundled locally for the redesigned UI. Webpack also copies the icon set from `public/` and explicitly ignores Finder metadata (`.DS_Store` and `._*`) so it cannot enter an extension package.

## Related

- `webpack.config.js` (`transformManifest`) — the transform itself.
- [`platform/capabilities`](../src/platform/capabilities/README.md) — why `oauth2` is Chrome-only (the auth seam / ADR-0002).
- [`scripts/`](../scripts/README.md) — `check-production-build` guards that no dev-only bits leak into a production bundle.
