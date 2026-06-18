# Platform / Chrome — the extension-API seam

> The **one place** the codebase touches `chrome.*`. Every other module calls these thin wrappers, never the raw API. For symbol-level structure use codegraph (`codegraph_explore "getMediaStreamIdForTab awaitDownloadSettled hasLocalStorageArea"`).

> **Archetype:** *Platform Runtime* (adapter seam) — deliberately **not** diagrammed; it's a wrapper *catalog*. Its value is the seam itself and the few wrappers that carry real behavior. If you read one thing, read **Why the seam exists**.

## Purpose & mental model

A boundary between our logic and the Chrome extension platform. Most wrappers just promisify a callback API and surface `chrome.runtime.lastError` as a rejection; a few add real resilience. The mental model: **if it says `chrome.`, it lives here** — so the rest of the code is testable and (mostly) browser-agnostic.

## Why the seam exists

- **Testability.** Mock `chrome.*` in one place; unit tests inject fakes for these wrappers, not the global.
- **Cross-browser (ADR-0002).** Most of `chrome.*` is Chromium-common, so these wrappers port unchanged; the *one* real divergence (OAuth) is isolated behind a separate seam — see [`platform/capabilities`](../capabilities/README.md).
- **Graceful degradation.** The storage wrappers **degrade to a no-op** when an area is missing (some hosts expose `chrome` without `chrome.storage` — e.g. the e2e tab-capture runtime), so the stop/finalize pipeline never aborts just because a crash-recovery marker couldn't be written.
- **Uniform error handling.** Callback APIs become promises that reject on `chrome.runtime.lastError`, in one consistent shape.

## Key invariants & gotchas

- **Never call `chrome.*` directly outside this folder.** New API surface gets a wrapper here first.
- **Storage wrappers must not throw on a missing area.** `hasLocalStorageArea` / `hasSessionStorageArea` gate every call → empty read / no-op write. This is load-bearing for the recording pipeline, not defensive paranoia.
- **`awaitDownloadSettled` is event-driven, not a timer.** It resolves on `chrome.downloads.onChanged` reaching a terminal state (plus an up-front `search` for the already-finished race, plus a timeout) — so a suspended MV3 worker reacts to the *actual* completion instead of dropping a blind timer. The background save handler depends on this to clean up OPFS only on confirmed `complete`.
- **`getMediaStreamIdForTab` has an E2E seam** — it returns a `__E2E_MOCK_TAB_CAPTURE__:` id under the mock-capture build so the e2e suite runs without real `tabCapture`.
- **Always check `chrome.runtime.lastError`** inside a callback before resolving — several APIs report failure only there.

## Files (the wrappers)

| File | Wraps / provides |
| :--- | :--- |
| `storage.ts` | local + session get/set/remove + `onChanged`; the **no-op-on-missing-area** degradation |
| `tabs.ts` | active-tab query, runtime-page tabs, tab messaging, `getMediaStreamIdForTab` (tabCapture), `getCapturedTabs` (conflict detection), `onRemoved`/`onUpdated` (the auto-stop triggers) |
| `downloads.ts` | `downloadFile` + `awaitDownloadSettled` (event-driven terminal-state wait) |
| `runtime.ts` | port connect, runtime messaging, `getManifest`/`getBuildId`, keep-alive poke |
| `identity.ts` | `getRedirectURL` + `launchWebAuthFlow` (consumed by the auth seam) |
| `offscreen.ts` | create / close / has-offscreen-document |
| `action.ts` | toolbar badge / action state |

## Testing notes

- These wrappers are the seam tests mock — `__tests__/platformChrome.test.ts` exercises the wrappers' own logic (degradation, `lastError` handling, the download settle race) against a fake `chrome` global; everything else mocks *these functions*, not `chrome.*`.

## Related

- [ADR-0002](../../../docs/adr/0002-cross-browser-support-strategy.md) — most of this seam ports cross-browser unchanged; the exception is OAuth.
- [`platform/capabilities`](../capabilities/README.md) — the auth seam (the one real cross-browser divergence); consumes `identity.ts`.
- [`background`](../../background/README.md) / [`offscreen`](../../offscreen/README.md) — the main callers (downloads, tabs, storage, offscreen lifecycle).

## External references

- Chrome — [`tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [`downloads`](https://developer.chrome.com/docs/extensions/reference/api/downloads), [`storage`](https://developer.chrome.com/docs/extensions/reference/api/storage), [`tabs`](https://developer.chrome.com/docs/extensions/reference/api/tabs), [`runtime`](https://developer.chrome.com/docs/extensions/reference/api/runtime), [`offscreen`](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [`action`](https://developer.chrome.com/docs/extensions/reference/api/action).
