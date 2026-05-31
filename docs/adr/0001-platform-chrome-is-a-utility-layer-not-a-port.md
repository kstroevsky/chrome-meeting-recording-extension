# ADR-0001 — `platform/chrome` is a normalization layer, not a substitutable port

- **Status:** Accepted
- **Date:** 2026-05-30

## Context

`src/platform/chrome/*` wraps Chrome extension APIs (storage, tabs, runtime
messaging, identity, downloads, offscreen, action badge). It looks like a seam
you could swap a different adapter behind — a "ports & adapters" boundary.

It is not one today, and an architecture review flagged the tension:

- **One adapter.** Only the real-Chrome implementation exists. Tests do not
  swap an adapter at this seam — `tests/setup.ts` installs a global `chrome`
  mock and every suite exercises the real wrappers against it.
- **Leaked around.** Several call sites reached past the wrappers to raw
  `chrome.*` (e.g. `chrome.tabs.get` in the recording start flow,
  `chrome.storage.session.get` and `chrome.runtime.connect` in the diagnostics
  dashboard), so the layer was not even a consistent place to find Chrome
  access.

By the principle *one adapter is a hypothetical seam; two adapters is a real
one*, building a fake-able `ChromePlatform` port with dependency injection would
add interface surface without leverage: nothing varies across the seam, and the
global-`chrome` mock already gives tests full control.

## Decision

`platform/chrome` is a **thin normalization layer**, not a substitutable port:

- Its job is to hide Chrome's callback/`lastError`/Promise inconsistencies
  behind small Promise-returning functions, and to give Chrome *operations* a
  single home. The leverage is normalization and locality, not adapter-swapping.
- **All Chrome *operations* go through it.** Reaching past it to raw `chrome.*`
  for an operation that has (or warrants) a wrapper is a leak; close it by using
  or adding a wrapper. The operation leaks found in the review are now closed,
  and `getTab` / `addStorageChangedListener` / `removeStorageChangedListener`
  were added so callers stop bypassing the layer.
- **Entry-point listener *registration* stays inline.** Binding
  `chrome.runtime.onMessage` / `onConnect` / `onSuspend` at the background,
  popup, offscreen, and content-script entry points is the platform binding
  itself; it normalizes nothing, so wrapping it would be indirection without
  leverage. Type-only references to `chrome.*` types are likewise fine.
- **We do not maintain a fake `Platform` adapter for tests.** Tests mock the
  global `chrome` object by design.

## Consequences

- `platform/chrome` is the single place to find and audit Chrome *operation*
  access, and the single place Chrome's API quirks are normalized.
- Future architecture reviews should **not** re-propose turning this into a
  ports-and-adapters seam with a fake adapter unless a real second
  implementation appears (e.g. a non-Chrome target), at which point this ADR
  should be revisited.
- New Chrome *operations* get a `platform/chrome` wrapper rather than a direct
  call at the use site.
