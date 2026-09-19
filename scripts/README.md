# Scripts — build, release & real-Meet e2e helpers

> Node (`.mjs`) scripts invoked by `package.json` for release gating and the real-Meet e2e harness. Not part of the extension bundle.

| Script | npm script | What it does |
| :--- | :--- | :--- |
| `check-version-monotonic.mjs` | `check:version` (part of `release:build`) | refuses a release with uncommitted changes, or a version lower than the latest release tag — the Chrome Web Store rejects a version that does not go up |
| `print-release-version.mjs` | `release:version` | prints the checked-out commit's release version (`a.b.c.d`, counted from git) |
| `check-commit-message.mjs` | the commit-msg hook | refuses a commit subject without a known prefix, since the prefix decides the version |
| `install-git-hooks.mjs` | `prepare` / `hooks:install` | installs that hook into `.git/hooks` without touching the hooks already there |
| `check-production-build.mjs` | `test:production-guards` (part of `release:build`) | asserts a production bundle has the exact telemetry host permission and retry alarm and leaked no E2E-only markers — the production-safety gate |
| `run-real-meet-e2e.mjs` | `test:e2e:real` / `:live` | drives the real-Google-Meet harness against a configured Chrome profile |
| `setup-real-meet-profile.mjs` | `test:e2e:real:profile` | provisions the stable Chrome profile the real-Meet run reuses |
| `lib/` | — | shared helpers for the release version (`releaseVersion.cjs`), Chrome version rules, target profiles, and strict telemetry endpoint validation |

## Release flow

`npm run release:build` chains the guards: `check:version` → `build` → `test:production-guards`. So a release build can't ship with a stale version or a dev-only permission. (The version is counted from git history; see [Versioning and releasing](../README.md#versioning-and-releasing).)

## Browser-target profiles

The manifest target model in `lib/manifestTargets.cjs` supports `chrome`, `edge`, `brave`, `opera`, `vivaldi`, and `arc`. `npm run build:edge`, `build:brave`, and `build:opera` are convenience aliases; the other supported Chromium profiles can be built with `npm exec -- webpack --mode=production --env target=<target>`.

Chrome uses the `chrome.identity.getAuthToken` manifest configuration. The other supported Chromium profiles use `launchWebAuthFlow`: their emitted manifest drops `oauth2` but **retains the stable `key`**, because the resulting extension id is part of the registered Chromium OAuth redirect URI. Firefox deliberately has no profile: it needs real capture-source and media-host adapters before the manifest can advertise support.

## Related

- [`static/`](../static/README.md) — the manifest transform whose output `check-production-build` validates.
- [ADR-0002](../docs/adr/0002-cross-browser-support-strategy.md) — the supported-target boundary and the prerequisites for a future Firefox port.
- [`tests/scripts/`](../tests/README.md) — the `node --test` suite that unit-tests this `lib/` (manifest source/version).
