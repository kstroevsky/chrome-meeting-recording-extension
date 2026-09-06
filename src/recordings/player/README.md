# Player — watching a recording back

> Part of the [recordings page](../README.md). Cross-context flows (manifest, Drive authorization, leases) live in [`background`](../../background/README.md); the storage split this reads from is documented in [`offscreen/storage`](../../offscreen/storage/README.md). Decisions: [ADR-0006](../../../docs/adr/0006-retained-media-and-native-playback-transports.md).

## Purpose and mental model

A modal on the recordings page that plays one recording back. Think of it as **a thin controller over native media elements** — it resolves *where* the bytes are and hands a URL to a `<video>`, then keeps the other tracks on that element's clock.

The one rule everything else follows from:

> **The control plane moves metadata and capabilities. The browser media stack moves the bytes.**

Nothing here reads a recording. A 3 GB file costs one object URL, and the service worker never sees a byte of it.

## The contract

The player is handed a `PlaybackManifest` ([`shared/playback.ts`](../../shared/playback.ts)) and resolves each track to a URL:

| Source | How it plays | Notes |
| :--- | :--- | :--- |
| `opfs` | `getFile()` → `createObjectURL` | Preferred. Read in the page, never in the worker. |
| `drive` | background installs a tab-scoped DNR rule, returns the URL | The page never receives the token. |
| `download` | not playable | `chrome.downloads` exposes no bytes; offered as "open the downloaded file". |

Sources are preference-ordered by the manifest, and a miss falls through to the next rather than failing the track.

## Key invariants and gotchas

- **The master is only ever a *streamable* track.** A tab track that exists but has nothing except a Downloads copy is not the master — picking it would fail a recording whose mic track is right there and readable.
- **A `File` from an OPFS handle is tied to the underlying file.** `FileSystemHandle.move()` invalidates it, which is why promotion returns the File it read back from the new location. Building a URL from the pre-move reference produces a download that never completes — it shipped once and only E2E caught it.
- **Object URLs pin their OPFS file.** Every one is revoked on close, master and auxiliaries alike.
- **The camera track is muted by construction.** It carries no audio; unmuting it would double the tab audio.
- **`el.duration` is `Infinity` on a retained copy.** The WebM duration fix produces a new in-memory Blob that goes to Downloads and Drive; the bytes left in OPFS keep the unfixed header. The player takes its total from the manifest's recorded duration instead — which is the better source anyway, because it is pause-aware ([ADR-0005](../../../docs/adr/0005-notations-are-a-separate-timecoded-aggregate.md)) and a container duration is not.
- **Bare letters must never fire while a field has focus.** That single rule is what makes the rest of the map safe as unmodified single keys; see `playerKeymap.ts`.

## Synchronization

One clock, `PlaybackClock`, with the tab track as master. Correction is deliberately reluctant — seeking an element is *audible*, so a stream of micro-seeks sounds worse than the drift it fixes:

| Drift | Action |
| :--- | :--- |
| < 30 ms | ignore |
| 30–150 ms | report, do not seek |
| > 150 ms | hard resync |

Offsets are **signed**: a track whose first sample predates the master sits *ahead* of it, `aux = max(0, master − offset/1000)`.

## Failure modes

| Failure | What the user sees |
| :--- | :--- |
| Recording tombstoned or missing | "This recording is no longer available." |
| Only a Downloads copy (pre-ADR-0006 local recording) | Pointed at the downloaded file |
| Retained file gone (stale location) | Falls through to Drive; message only if nothing remains |
| Drive file deleted, or token refused | One bounded refresh, then "Could not open this recording from Google Drive." |
| Offline | Same path — `prepareDriveSource` rejecting is caught |

The Drive retry is **exactly once per open**. A retry loop against a genuinely deleted file would hammer Drive.

## Files

| File | Role |
| :--- | :--- |
| `PlayerController.ts` | Orchestration: manifest → sources → elements → clock |
| `PlayerView.ts` | The modal DOM (design card `f12`) |
| `PlaybackClock.ts` | Master/auxiliary synchronization and drift bands |
| `playbackSource.ts` | One track → a URL a media element can take |
| `playerFormat.ts` | Clock text, note-mark placement, seek fraction |
| `playerKeymap.ts` | The `f19` map, resolved as data |
| `playerTracks.ts` | What FILES and the volume popup are lists of |

## Testing notes

Unit tests cover the pure modules and the controller's failure paths (`tests/helpers/fakeOpfs.ts` stands in for OPFS). **The interesting bugs have all been found by E2E**, because unit tests mock `File` and cannot see handle semantics:

- `tests/e2e/recording-playback.spec.ts` — promotion → playback, multi-track sync, keyboard, FILES, settings, and deletion while playing
- `tests/e2e/drive-playback.spec.ts` — a Drive-only recording and the shape of the installed rule

One harness limit worth knowing: Playwright fulfils an intercepted request *before* declarativeNetRequest's `modifyHeaders` runs, so the injected `Authorization` header is unobservable in E2E. That the rule reaches the wire is proven against real Drive in `tests/spikes/drive-playback`.

## Related

- [ADR-0006](../../../docs/adr/0006-retained-media-and-native-playback-transports.md) — retained media, native transports, token isolation
- [ADR-0005](../../../docs/adr/0005-notations-are-a-separate-timecoded-aggregate.md) — why notation times are exact media offsets
- [ADR-0001](../../../docs/adr/0001-platform-chrome-is-a-utility-layer-not-a-port.md) — why the DNR calls go through `platform/chrome`
