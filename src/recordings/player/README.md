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

## Topics

A finished recording that has been analysed (ADR-0007) carries `manifest.topics`, and the player shows them two ways: a **band under the scrubber**, one stripe per span, and a **TOPICS popover** listing each topic once with its total minutes. `T` / `⇧T` walks them the way `N` / `⇧N` walks notes.

The distinction that shapes all of it:

> **A topic is global; a span is temporal.** A call that returns to Redis after twenty minutes of hiring is *one* topic with *two* spans.

So the band draws spans and the list draws topics, a topic's `23 min` is the **sum** of its spans rather than last-minus-first, and a shade is keyed to the topic so the stripe at 05:00 and the stripe at 31:00 are visibly the same subject. Four shades cycle; past four, two topics share one and the label disambiguates — the band was never the identifier.

Everything topic-shaped disappears when `topics` is empty, which covers never-analysed, still-running and stale-under-new-settings alike. All three mean "nothing to show", and a `TOPICS 0` trigger would promise otherwise.

The manifest carries no vectors. Centroids and segment embeddings stay in the `analyses` store for the deferred retrieval work; the player needs words and offsets.

## Transcript

A recording with a persisted transcript (ADR-0007, `manifest.transcriptStatus === 'ready'`) gets the design's `f10` rail beside the picture: the video keeps 462px and the rail lists every line with its time and speaker, the line being spoken banded and its time in the playhead's red, and a subtitle band on the picture shows the same line. Lines said during a note sit under that note's sticky heading, joined by a gold rail in the gutter; a line belongs to the earliest-starting note whose range holds its start (`playerTranscript.railItems`). Clicking a line or a heading seeks there. The header's panel toggle and `T` hide and restore the rail, `C` and the Subtitles row toggle the band, and SRT downloads the transcript as SubRip. A transcript with no notes heads the rail `NO NOTES` (`f14`). Topic walking is `G` / `⇧G`, not `T`: the map gives `T` to the transcript itself (`f19`).

The rail is also where a note is renamed (`f18`): hovering a heading reveals a pencil, and clicking it or the heading's name turns the heading into a mono field. Enter or the tick keeps the name, Escape puts the old one back, and the scrubber mark keeps its place, since a name never touches the timing. `R` renames the note under the playhead, opening the rail to do it. The write is the same `UPDATE_RECORDING_NOTATION` the details dialog makes, supplied by the page as `renameNotation`; without it the headings only play.

A long rail reads as an index (`f20`). From `RAIL_INDEX_NOTES` (12) notes up, the rail gains a search field under its header and every heading carries its start time on the right. Search keeps a line by its words or speaker and a heading by its name; a matching heading keeps its lines and a matching line keeps its heading, so every hit still says which note it sits in. `/` goes to the search. On the scrubber, marks that would overlap merge into one taller mark with an inset edge (`playerFormat.mergeNoteMarks`); a merged mark cannot know which note was meant, so clicking it brings its notes into view in the rail instead of seeking. Marks are drawn in the fixed on-picture gold `#c99a55` in both themes.

Fullscreen keeps the rail (`f15`). With the popup header gone, the name and date move onto the picture, top left, and the rail becomes a dark translucent 250px panel over the picture's right edge, with its own hide button and a `TRANSCRIPT` label. Everything on the picture — scrim, subtitles, scrubber, controls, self view — stops 20px short of it. A rail hidden in fullscreen comes back from a button among the picture controls, which only exists there. The panel keeps the picture's colours in either theme by overriding the page tokens locally.

Without a transcript the rail is **absent**, not hidden, and the header loses its toggle — `f11`/`f12`. The transcript is read beside playback rather than before it (`GET_RECORDING_TRANSCRIPT`), so a failure costs the rail and says nothing on the picture. Speaker names come from Meet's captions; the design's `TAB` / `MIC` source tags have no equivalent in a caption transcript.

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
| `PlayerView.ts` | The modal DOM (design cards `f12`, `f10` with a transcript, `f16` quiet) |
| `PlaybackClock.ts` | Master/auxiliary synchronization and drift bands |
| `playbackSource.ts` | One track → a URL a media element can take |
| `playerFormat.ts` | Clock text, note-mark and topic-band placement, seek fraction |
| `playerKeymap.ts` | The `f19` map, resolved as data |
| `playerTracks.ts` | What FILES and the volume popup are lists of |
| `playerTopics.ts` | What TOPICS is a list of |
| `playerTranscript.ts` | What the rail is a list of: note grouping, the playing line, the note under the playhead, SRT |

## Testing notes

Unit tests cover the pure modules and the controller's failure paths (`tests/helpers/fakeOpfs.ts` stands in for OPFS). **The interesting bugs have all been found by E2E**, because unit tests mock `File` and cannot see handle semantics:

- `tests/e2e/recording-playback.spec.ts` — promotion → playback, multi-track sync, keyboard, FILES, settings, and deletion while playing
- `tests/e2e/drive-playback.spec.ts` — a Drive-only recording and the shape of the installed rule

One harness limit worth knowing: Playwright fulfils an intercepted request *before* declarativeNetRequest's `modifyHeaders` runs, so the injected `Authorization` header is unobservable in E2E. That the rule reaches the wire is proven against real Drive in `tests/spikes/drive-playback`.

## Related

- [ADR-0006](../../../docs/adr/0006-retained-media-and-native-playback-transports.md) — retained media, native transports, token isolation
- [ADR-0005](../../../docs/adr/0005-notations-are-a-separate-timecoded-aggregate.md) — why notation times are exact media offsets
- [ADR-0001](../../../docs/adr/0001-platform-chrome-is-a-utility-layer-not-a-port.md) — why the DNR calls go through `platform/chrome`
