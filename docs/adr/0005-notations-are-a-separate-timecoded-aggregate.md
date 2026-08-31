# ADR-0005 — Notations: media-relative timecodes in their own aggregate, not container metadata

- **Status:** Accepted
- **Date:** 2026-08-30

## Context

A recording carries exactly one piece of user-authored metadata today:
`RecordingHistoryEntry.note` — a single free-text string with no time dimension,
wired end-to-end through `SET_RECORDING_HISTORY_NOTE`. We want the plural,
time-bearing version — **notations**: `(tStartMs, tEndMs?) + text`, so a user can
mark "decision made here", "demo starts", or "skip this bit" against a point or
span of a recording.

Two questions had to be answered before any code:

**1. Where do the timecodes come from?** The extension's wall clock is not the
recording's timeline. A recording can be paused (`RecorderEngine.setPaused`
pauses every `MediaRecorder`), and a paused span is never written into the media,
so wall-clock elapsed time and playback position diverge the moment anyone
pauses.

**2. Where do notations live?** The obvious answer — a field on
`RecordingHistoryEntry`, next to `note` — collides with the recording lifecycle:
`historyId` is minted at `RecordingSession.start()`, but the IndexedDB history
row is not created until finalize, by `RecordingHistoryService.createPending`
(local) or `applyUploadJob` (drive). A mark made at minute 5 of a recording has
no row to attach to, and `normalizeRecordingHistoryEntry` drops any row with an
empty `files` array, so a provisional row is not available either.

The tempting third option — write the marks into the media file's own container
metadata — deserved a real answer rather than a reflex, since this pipeline
*already* rewrites the WebM container post-seal (`webm-duration-fix` in
`src/offscreen/storage/opfsWorker.ts`).

## Decision

**1. Notation timecodes are media-relative offsets, stamped from the background's
pause-aware recording clock.** `RecordingSession.currentRecordedMs()` exposes the
existing `recordedMs + (runningSince ? now - runningSince : 0)` computation.
Because a paused span is never written into the media, this clock's domain is
identical to playback position in the produced file — a notation seeks correctly
with no pause-gap correction. This equivalence is pinned twice: a unit test in
`src/background/__tests__/RecordingSession.test.ts` asserts that two marks
separated by 5 s of recording and 10 s of pause are 5 s apart, not 15 s, and
`tests/e2e/recording-notations.spec.ts` asserts the same property end-to-end
against a real `MediaRecorder` pause in a real browser.

**2. Notations are their own aggregate, keyed by `historyId`, in a second
`notations` object store in the existing `recording-history` database** (v3 → v4).
A mark lands durably the instant it is made, with no dependency on the history
row's lifecycle; the history row appears later and the two join by id.

**3. The database version and its `onupgradeneeded` are owned by one module.**
`src/background/recordingHistoryDatabase.ts` now owns `DATABASE_VERSION` and
creates both stores; `RecordingHistoryRepository` and
`RecordingNotationRepository` both delegate to it and share one connection per
`IDBFactory`. Two repositories declaring their own version of the same database
would downgrade-block each other on open.

**4. Notations are never written into the media file's container metadata.**
Structured records are the source of truth. Export to an interop sidecar —
**WebVTT** (`.vtt`), whose `00:00:12.500 --> 00:00:41.000` + text *is* the model,
and which is the standard `<track kind="chapters">` format — is a later slice.

**5. Live marking is guarded on `phase === 'recording'` specifically**, not the
broader `isStoppablePhase` the other live commands use. During `starting` the
clock still reads 0 and the offscreen has not confirmed capture; during
`stopping` it is already banked while the media seals. A mark taken in either
window would point at an offset the file does not have.

**6. A note the run outlives is sealed, never discarded.** When a run ends —
normally or in failure — every span still open is closed at the last recorded
position and marked `endedBy: 'auto'` (versus `'user'` for one the user closed
deliberately). This comes from the design: *"a note that was still open when the
recording died is closed at the last saved frame and marked, rather than
disappearing"*, which a screen renders as a dashed edge and an "ENDED AT" label.
`RecordingSession` announces the end once via `onRunFinished(historyId,
durationMs)` — the same seam that banks the duration — and the sealing is
idempotent and best-effort, so it can never disturb the phase transition.

Deliberately only two values: whether the recording ended *normally* or was
*interrupted* is already recorded on the history entry, and a notation should
not carry a second opinion about it.

**7. A failed notation write is a data-plane error, not a capture failure.**
Notation commands return `NotationResult` / `NotationListResult`, never
`CommandResult`, and are listed in `NON_SESSION_RESPONSE_MESSAGE_TYPES` so the
router's failure path answers `{ ok: false, error }` instead of calling
`session.fail()`. A recording must not die because a mark could not be stored.

**8. Live notation commands name the *run*, not a recording id.** `toStatusView`
drops the live session's `historyId` (it is control-plane bookkeeping the popup
does not render), so the popup has no id for the run currently recording. The
live UI therefore uses an *active-run* message family (`MARK_NOTATION`,
`END_NOTATION`, `LIST_ACTIVE_NOTATIONS`, `UPDATE_ACTIVE_NOTATION`,
`REMOVE_ACTIVE_NOTATION`) that the background resolves against the current
session; the keyed messages remain for surfaces that legitimately hold a
recording id.

This follows a line the protocol already draws: **live commands are id-less,
history commands are keyed.** `STOP_RECORDING`, `DISCARD_RECORDING`,
`SET_MIC_MUTED`, `SET_CAMERA_MUTED`, `SET_PAUSED` and `SET_INPUT_DEVICE` all
name no run — they mean "the run happening now" and the background resolves it —
while `RENAME_RECORDING_HISTORY` and friends operate on a finished recording by
id. `historyId` is minted per run in `start()` and dropped at idle, so it is a
per-run identity rather than a handle the popup holds.

It is a projection boundary, not a secret: the popup *does* receive `historyId`
for finished runs on `UploadJob.historyId`, and already uses it to rename a
completed recording. Widening the projection would also have worked — the popup
would get a fresh id on each status push, so staleness is no worse than for
`SET_PAUSED`. Consistency with the existing live-command shape is the reason to
prefer this form, not safety.

**9. One gesture starts a note and the same gesture ends it** — the ⌥M
`mark-notation` command, and the ribbon's toggle. `RecordingController.toggleNotation`
owns that decision because the keyboard path has no popup state to consult.

## Alternatives considered

**Write `Chapters` into the WebM container.** Format-legal — Matroska/WebM
supports `ChapterAtom` with `ChapterTimeStart`/`ChapterTimeEnd`/`ChapString` —
and mechanically reachable, since the pipeline already rewrites EBML post-seal.
Rejected on four counts: (a) marks are made *during* capture, hours before the
sealed artifact exists, so there is nothing to write into at mark time;
(b) notations are mutable and the media is not — editing one would mean
rewriting a multi-GB file, which for `storageMode: 'drive'` may already be
uploaded and deleted from OPFS; (c) Chrome's `<video>` never exposes WebM
chapters to JS and Drive's preview ignores them, so only ffmpeg and desktop
players could read them; (d) the pipeline also emits `.mp4`/`.m4a`, where
chapters are an entirely different and worse mechanism. "Burn chapters into an
exported copy" remains available later as an explicit export action — never as
storage.

**A field on `RecordingHistoryEntry`.** Consistent with `note`, and the
export/rename paths already carry the entry around. Rejected: the history row
does not exist while marks are being made (see Context), and creating a
provisional one would mean weakening the empty-`files` guard in
`normalizeRecordingHistoryEntry` — an invariant that exists to drop junk rows.

**Buffer marks on `RecordingSessionSnapshot`, flush at finalize.** The snapshot
is persisted to `chrome.storage.session` on every commit, so it *is* durable
across service-worker restarts. Rejected: the snapshot is broadcast to the popup
on every commit and an unbounded list has no business on that hot path;
`normalizeSessionSnapshot` strips capture-scoped fields at idle, so notations
would need a bespoke exception; and `chrome.storage.session` dies with the
browser session.

**A separate IndexedDB database.** Cleanest isolation, but the recordings page
already opens `recording-history`, and a join across two databases buys nothing
when a second object store costs one version bump.

## Consequences

- A mark is durable the moment it is made, independent of whether the recording
  is ever finalized — so `RecordingController.discard()` must (and does) drop the
  run's notations explicitly, and `RecordingHistoryService.remove()` drops them
  via an injected `onRemoved` callback.
- Notations survive a recording whose upload fails or is recovered later, because
  they were never coupled to the artifact.
- Reading a recording with its notations is two reads, not one. Acceptable: no
  current surface lists many recordings *with* their marks.
- The `recording-history` database is now shared. Any future store goes in
  `recordingHistoryDatabase.ts` with a version bump there, never in a repository.
- Because storage is structured, the eventual export can render both notations
  and the planned `TranscriptSegment` model
  (`docs/plans/portable-transcription.md`) into the same WebVTT artifact — they
  are the same shape minus the speaker label.
