# ADR-0006 — Retained media is not staging, and the browser moves the bytes

- **Status:** Accepted — both spikes in "Validation" ran and passed
- **Date:** 2026-09-03 (accepted 2026-09-04)

## Context

The extension can record but cannot play back. Adding a player forces two
questions that the current storage model cannot answer, because it was built for
a pipeline that always *ends* in delivery.

**1. Who owns recorded bytes after delivery?** Today OPFS is capture/recovery
staging and nothing else. `StorageTarget` seals an artifact carrying an
`opfsFilename`, and that string means "recovery-owned OPFS bytes". The local-save
path proves the intent: only once Chrome reports the download `complete` does
background send `revokeBlobUrl(blobUrl, opfsFilename)`, deleting the OPFS source;
interrupted or timed-out downloads deliberately leave the file behind for
recovery. `recoverOrphanRecordings` completes the picture — it treats *any*
leftover recording file in OPFS as an abandoned capture to be recovered and then
deleted. Successful Drive uploads likewise clean their staging artifact.

So after a successful local save the extension owns no bytes at all: history
keeps only a `downloadId`. There is nothing for a player to read.

The tempting shortcut — stop calling cleanup, and yesterday's temporary file
becomes today's media library — is wrong. It does not create ownership; it
removes the only signal that says who is responsible for a file. Orphan recovery
would begin recovering the library. Retention, retry, and cleanup would all have
to re-derive intent from a filename. The repo's storage semantics are stronger
than that shortcut respects.

**2. What moves multi-gigabyte media?** A recording can be gigabytes. Any design
that routes those bytes through the MV3 service worker, through `fetch()` into
JavaScript, or through `arrayBuffer()` into a single allocation is a design that
fails on exactly the recordings users care most about. The service worker can
also be evicted between any two events (ADR-0003), so it is the worst possible
owner of a long-lived byte stream.

Google Drive's `files.get?alt=media` endpoint serves blob content and supports
HTTP `Range`, which is precisely what a media element needs for buffering and
random seeking. The obstacle is authentication: a `<video>` element cannot set an
`Authorization` header. Chrome's declarativeNetRequest *can* set request headers
before they are sent, and its session rules can be scoped to a single `tabId`.

The full design this ADR records is in
[`docs/plans/recording-player.md`](../plans/recording-player.md) (canonical base
r1). This ADR fixes the four decisions that plan depends on, so later slices have
something to be consistent with.

## Decision

**1. Staging and retained media are separate concepts, in separate OPFS
directories.** OPFS gains two roots with different owners:

```text
OPFS
├── staging/     owned by recording / finalization / recovery
└── library/     owned by the recording library / player
```

A file in `staging/` may be mid-capture, sealing, pending Drive upload, pending
local delivery, or a crash orphan — the existing resilience machinery continues
to apply to all of it. A file in `library/` means one thing: *these bytes are
intentionally retained by the extension.*

**Orphan recovery must never enumerate `library/`.** Deleting retained media is
history/retention's job, never capture recovery's. This is the invariant that the
"just stop calling cleanup" shortcut would have destroyed.

**2. Ownership transfers by promotion, and promotion is idempotent, not atomic.**
Moving from staging to library is an explicit `RetainedMediaStore.promote()` step
that consumes the staging artifact. It uses `FileSystemHandle.move()` so a
multi-gigabyte recording changes owner without an application-level byte copy,
with a bounded-memory `source.stream().pipeTo(destination)` fallback where
`move()` is unavailable **or rejected at call time**. Capability is decided by
*calling* `move()` and catching, never by `typeof handle.move === 'function'` —
the spike below found a shipping Chromium target that exposes the method and
throws `NotAllowedError` from it.

The move and the IndexedDB metadata update cannot share a transaction, so
promotion does not pretend to be atomic. Library keys are deterministic
(`library/<encoded-history-id>/<encoded-file-id>.webm`), `promote()` is safe to
re-run, and a startup reconciler repairs the crash cases — repairing missing
metadata, garbage-collecting library files whose recording is tombstoned or
absent, and dropping history locations whose file is gone. This matches how the
repo already handles crash recovery rather than importing distributed-transaction
semantics.

**3. A recording artifact is immutable logical media; OPFS, Drive, and Downloads
are replicas of it.** `RecordingHistoryFile.destination: StorageMode` conflates
two questions that playback separates:

- *Where can I play this from?* → `locations: ArtifactLocation[]`
- *Did the user's requested delivery succeed?* → `delivery: { requested, status }`

`storageMode` keeps its current meaning: what the user asked for at recording
time. A single logical `tab.webm` may simultaneously have an OPFS retained copy,
a Downloads copy, and a Drive copy — and a failed Drive upload that fell back
locally is now a *fully playable* recording with two replicas, rather than an
error state. Migration is additive: the normalizer synthesizes locations for
legacy `downloadId` / `driveFileId` rows in memory, and the legacy fields stay
through one migration period.

**4. The control plane moves metadata and capabilities; the browser media stack
moves media bytes.** Background owns metadata, source selection, and
authorization, and never reads media. The player page reads OPFS directly
(`getFile()` → `blob:` URL → `<video>`; never `arrayBuffer()`). Drive plays
through a native media element pointed at the Drive URL, letting Chromium own
range requests, seeking, buffering, and eviction.

Source preference is **OPFS → Drive → Downloads**, where Downloads is an
external-open fallback, not a streaming source: `chrome.downloads` exposes no
bytes to the extension and must not be treated as a media transport.

**5. Drive authorization is a narrow, tab-scoped, transient capability — the
token never leaves background.** The player receives the Drive media URL and
never the OAuth token. Authorization is attached by a declarativeNetRequest
session rule that sets the `Authorization` header, matching on *all* of: the
player's tab id, `GET`, the `media` resource type, `www.googleapis.com`, and the
exact Drive file path. A `www.googleapis.com/*` rule would hand the token to every
Google API request in that tab and is forbidden.

Two supporting rules:

- Per ADR-0001, the DNR calls get a `platform/chrome/declarativeNetRequest.ts`
  wrapper rather than raw `chrome.*` at the use site.
- Background derives the tab id from `sender.tab?.id` and validates the sender is
  an extension-owned `player.html`. **A player-supplied `tabId` is never
  accepted** — otherwise any surface could ask background to install Drive
  credentials into an arbitrary tab.

**6. Retained media is leased while it is being played.** An OPFS `File` stays
tied to its underlying storage object, so deleting a recording out from under an
open player is a real failure mode. A `PlaybackLease` keyed to the player's tab
id lives in `chrome.storage.session` — session storage, because the service
worker can die while the player tab stays open. Deleting a recording tombstones
history immediately, but defers *internal* media deletion until the lease is
released; startup reconciles leases against live tabs and finishes deferred
cleanup. This mirrors ADR-0004's reasoning: a lifecycle that outlives the
recording epoch carries its own id rather than borrowing the epoch.

Deletion semantics become explicit, and narrower than the current
"Files will not be deleted." copy implies: remove-from-history tombstones the
entry, drops the notation aggregate, and removes extension-owned OPFS playback
copies — but never deletes Downloads files or Drive files.

## Validation

This ADR rested on two platform assumptions. Both were measured before anything
was built on them, and both held:

1. **Drive range playback — RUN, PASSED** (`tests/spikes/drive-playback/`,
   2026-09-04, against a real 3,421,476,828-byte MediaRecorder WebM the
   extension itself uploaded — 3.26 GB, 89.5 minutes).

   `probe.mjs` walked the chain sending `Authorization` on the first hop only:

   ```
   hop 1: 206 www.googleapis.com  content-range: bytes 0-1023/3421476828
   ```

   **There is no redirect.** Google's `curl -L` example notwithstanding, the
   media response terminates on `www.googleapis.com`, so the DNR rule stays
   scoped to that one host and no second host has to be added. (`Accept-Ranges`
   is *absent* from the response; the 206 plus `Content-Range` is the actual
   evidence of range support, so don't gate on that header.)

   `run.mjs` then drove a real `<video>` with no token in the page, authorized
   only by a tab-scoped session rule, measuring bytes over CDP:

   | seek | landed | transferred | prefix if linear | range requests |
   | --- | --- | --- | --- | --- |
   | 80% | 4298.0 s | 13.1 MB | 2610.4 MB | `bytes=0-`, `2723348480-`, `2725576704-` |
   | 90% | 4835.3 s | 15.0 MB | 2936.7 MB | `bytes=0-`, `3075112960-` |

   Metadata cost 0.8 MB. Chromium jumps straight to the byte offset; only
   `www.googleapis.com` is contacted; no 401/403 on any hop; the token appears in
   no page surface. **A 3.26 GB WebM produced by this pipeline is already
   remotely seekable**, so the post-seal container-normalization contingency
   below is not needed today.
2. **Copy-free promotion — RUN, PASSED.** `tests/spikes/opfs-move-spike.mjs`
   promotes a 128 MB file from `staging/` to `library/` and compares `move()`
   against the stream-copy fallback:

   | Target | Chromium | `move()` present | `move()` usable | promote | copy | verdict |
   | --- | --- | --- | --- | --- | --- | --- |
   | Chromium (Playwright) | 148 | yes | yes | 1 ms | 241 ms | copy-free |
   | Brave | 149 | yes | yes | 1 ms | 360 ms | copy-free |
   | Microsoft Edge | 118 | **yes** | **no** — `NotAllowedError` | — | 471 ms | fallback |

   Bytes verified intact at both ends, `staging/` emptied, `library/` holding the
   promoted file. Promotion is ~240-360x faster than copying and flat in file
   size, which is the copy-free property the design needs.

   **The Edge row is the load-bearing result.** `move()` is *present* there and
   throws when called, so presence-based feature detection would pass and then
   fail in production. Detection must be call-based. (That Edge install is
   version 118 and badly out of date, so this is not necessarily true of current
   Edge — but the design must not assume it isn't.)

**Exit criterion (conjunctive):** seeking a representative Drive WebM/MP4 works
without downloading the whole object, *and* promotion works without a
byte-for-byte copy on the primary targets. **Both halves are met.**

One operational caveat learned while running these: Chrome 152 ignores
`--load-extension` entirely, and Playwright's `connectOverCDP` cannot reach an
extension service worker in an already-running browser. Extension-loading
automation therefore has to use Playwright's bundled Chromium, which has no
Chrome sign-in and so no `chrome.identity.getAuthToken` — the spike takes a
token minted from the real extension instead. Any future automated Drive
playback test needs the `WebAuthFlowAuthProvider` path (ADR-0002).

Seekability is a property of the file, not only of the transport: the WebM
pipeline's post-seal duration fix makes duration correct, which is not the same
as efficient random access. **Corrected 2026-09-05** — that was true of the Blob
the seal returned but not of the file. See "Duration has to reach the file"
below. Acceptance therefore used a large real
MediaRecorder-produced WebM rather than a small fixture, and that file seeks
correctly. Should a future encoder or settings change regress this — a far seek
dragging a long byte prefix — the defect is container indexing and the fix is a
post-seal container normalization step, not a change to this architecture.

## Alternatives considered

**Stop calling cleanup, and let staging files persist.** Rejected. It creates
retention without creating ownership, and silently converts orphan recovery into
a process that recovers the media library. Every downstream concern — retry,
retention, deletion, quota — would then have to infer intent from a filename.
Promotion costs one explicit step and buys an unambiguous owner.

**MediaSource Extensions.** Rejected. Feeding byte ranges through JavaScript into
a `SourceBuffer` means re-implementing container-aware byte windows, random
seeks, `SourceBuffer` eviction, buffering heuristics, codec initialization
segments, WebM/MP4 differences, retries, token refresh, cancellation, and memory
pressure — all of which Chromium already implements well. With a DNR-authorized
URL the whole problem is `video.src = driveUrl`.

**Copy staging → library instead of moving.** Rejected as the primary path; kept
only as the feature-detection fallback. A byte-for-byte copy of a multi-gigabyte
recording costs double the disk and a long stall at exactly the moment the user
expects the recording to be finished.

**Keep one `destination` field and add a boolean like `retainedLocally`.**
Rejected. It preserves the conflation this ADR exists to remove: delivery outcome
and physical location answer different questions, and a Drive-failed-then-
fell-back recording has no honest single `destination`.

## Consequences

- OPFS becomes durable product state, so quota becomes intentional:
  `"unlimitedStorage"` is added (it covers OPFS), usage is surfaced via
  `navigator.storage.estimate()`, and cleanup stays explicit — no silent
  age/size eviction ships until the product asks for it.
- `opfsFilename: string` is replaced by an explicit `StorageLocation`
  (`opfs-staging` | `memory`) on the sealed artifact. Passing an ambiguous string
  around is what made accidental deletion easy.
- The high-performance `WorkerStorageTarget` write path is **not** redesigned;
  only where it opens its staging file changes.
- Old local recordings stay unplayable in-extension: the extension no longer owns
  those bytes and only a `downloadId` remains. A "Relink local file" feature using
  a user-selected handle is possible later, and is deliberately out of scope.
- Drive retry keeps its current five-minute / 128 MB retained-artifact budget for
  now. Once fallback files have a real retained OPFS location, retry can upload
  from there instead — a follow-up, explicitly not a blocker for the player MVP,
  and a change that would touch ADR-0004's upload-job model.
- Notations need no architectural change. ADR-0005 already defines notation times
  as media-relative, pause-aware offsets in the produced media timeline, so
  `video.currentTime = notation.tStartMs / 1000` is exact rather than approximate,
  and the player reuses the existing notation messages.

## Duration has to reach the file (2026-09-05)

`move()` promotes whatever is *on disk*, and the duration fix was only ever
applied to the `Blob` the OPFS worker handed back. The bytes in the file were
never rewritten, so every promoted artifact reached the library without a
Duration element: `video.duration` read `Infinity`, the player could not seek,
and — because `RecordingFinalizer` builds the download's object URL from the
retained `File` — the saved `.webm` lost its duration too. The retained-media
work introduced this: before it, the download was built from the fixed
in-memory Blob.

The repair is to write the fixed bytes back to the staging file at seal, before
promotion. Three measurements decided it, taken on a real 389 KB capture and on
OPFS directly:

| Measurement | Value |
| --- | --- |
| Bytes the fix changes | 160, at offset 48 — but the file **grows by 76 bytes** |
| OPFS write throughput | ~670 MB/s (linear from 64 MB to 256 MB) |
| OPFS read throughput | ~1,800 MB/s |

The growth is what settles it. The fix inserts a Duration element rather than
overwriting spare bytes, so the body shifts and an in-place prefix patch — the
cheap option — is not available. A whole-file rewrite is, and at ~670 MB/s a
2 GB recording costs about three seconds, once, at finalisation. The parse the
fix performs is already paid today; only the write is new.

`createWritable()` is the mechanism, and not incidentally: the fixed Blob is a
lazy slice of the file being overwritten, so the read source must survive the
write. Chromium streams a `FileSystemWritableFileStream` into a swap file and
only replaces the original on `close()`, which keeps the slice readable
throughout and leaves the original untouched if the write fails partway.

Fix-on-read was the alternative and is worse: it repays the parse on every open,
including in the player, in exchange for a one-time three-second write.

A second hole sat behind the first. The fix was gated on
`mimeType === 'video/webm'`, but a separate microphone opens its storage target
as `audio/webm` (`resolveMicrophoneRecordingProfile`), so a mic track never had
its duration computed at all — the gate is now any WebM, audio or video, since
the repair is an EBML operation and indifferent to the codec inside.

This is what the two long-red `@perf-smoke` cases were reporting. Both assert
`durationSeconds` on a `micMode: 'separate'` run and both read `null`; the
tab-only case passed throughout, which is exactly the shape the gate predicts.
They had been verified as pre-existing at `da5fead` and treated as background
noise. They were not noise — they were this defect, and the whole `@perf-smoke`
suite is green now that both halves are fixed.

Known gap: when the write-back itself fails, the file stays unfixed and the
main-thread fallback still repairs only the delivered copy. That is the old
behaviour, now confined to a rare branch rather than being the normal path.
`tests/e2e/retained-media-duration.spec.ts` covers the normal path and fails
against the pre-fix worker; the audio half is covered by the `@perf-smoke`
mic cases, which flip red the moment the gate narrows again.
