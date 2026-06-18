# Scripts — build, release & real-Meet e2e helpers

> Node (`.mjs`) scripts invoked by `package.json` for release gating and the real-Meet e2e harness. Not part of the extension bundle.

| Script | npm script | What it does |
| :--- | :--- | :--- |
| `check-version-monotonic.mjs` | `check:version` (part of `release:build`) | asserts the release version only ever increases — guards against shipping a non-monotonic Chrome Web Store version |
| `check-production-build.mjs` | `test:production-guards` (part of `release:build`) | asserts a production bundle leaked **no** dev-only bits (e.g. `system.cpu`, the dev `key`) — the production-safety gate |
| `run-real-meet-e2e.mjs` | `test:e2e:real` / `:live` | drives the real-Google-Meet harness against a configured Chrome profile |
| `setup-real-meet-profile.mjs` | `test:e2e:real:profile` | provisions the stable Chrome profile the real-Meet run reuses |
| `lib/` | — | shared helpers (e.g. `manifestVersion.cjs` — `toChromeManifestVersion`, used by both the build and `tests/scripts/manifestVersion.test.mjs`) |

## Release flow

`npm run release:build` chains the guards: `check:version` → `build` → `test:production-guards`. So a release build can't ship with a stale version or a dev-only permission. (Version itself is single-sourced in `package.json`; see the [versioning protocol](../docs/plans/) and [`static/`](../static/README.md).)

## Related

- [`static/`](../static/README.md) — the manifest transform whose output `check-production-build` validates.
- [`tests/scripts/`](../tests/README.md) — the `node --test` suite that unit-tests this `lib/` (manifest source/version).
