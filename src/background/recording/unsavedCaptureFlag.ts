/**
 * @file background/recording/unsavedCaptureFlag.ts
 *
 * One durable bit: "a capture started and has not been accounted for since".
 *
 * It exists to keep the popup cheap. Finding a recording a crash left behind
 * means scanning OPFS, and OPFS belongs to the offscreen document — so asking
 * the question at all means *creating* that document and loading its bundle.
 * The scan itself is two directory listings; spinning up a document on every
 * popup open to run it is the part worth avoiding.
 *
 * So the flag is set when capture begins and cleared when the run reaches
 * idle — the point at which every artifact has been delivered, downloaded, or
 * handed to a background upload job that keeps its own recovery marker. A crash
 * anywhere in between leaves the flag set, which is exactly the case worth
 * looking into.
 *
 * Deliberately in `chrome.storage.local`, not `session`: the crash we care
 * about most takes the browser with it.
 *
 * It carries the run's own clock along with the bit — the same `recordedMs` and
 * `runningSince` the popup counts with, which exclude paused spans. The session
 * snapshot already holds those, but it lives in `storage.session` and the
 * browser clears that on shutdown, so a crash loses exactly the number worth
 * keeping. Mirroring it here costs one small write whenever the run's banked
 * time changes, and turns "63 MB" into "~32m · 63 MB".
 */

import { getLocalStorageValues, hasLocalStorageArea, setLocalStorageValues } from '../../platform/chrome/storage';

const UNSAVED_CAPTURE_KEY = 'captureMayBeUnsaved';

/**
 * A live run's clock, as the popup reads it: time already banked, plus the
 * moment the current span began. `runningSince` is null while paused.
 */
export type CaptureProgress = { recordedMs: number; runningSince: number | null };

/** Records that capture has begun, so a crash from here on is detectable. */
export async function markCaptureStarted(): Promise<void> {
  await write({ recordedMs: 0, runningSince: Date.now() });
}

/**
 * Keeps the mirrored clock current. Called as the session's banked time moves —
 * on start, pause and resume — not on a timer: between those moments the
 * elapsed time is a function of `runningSince`, so there is nothing to update.
 */
export async function noteCaptureProgress(progress: CaptureProgress): Promise<void> {
  await write(progress);
}

/**
 * How long the interrupted run had recorded by the time `endedAtMs` — its last
 * write to disk. Paused spans are already excluded, because the banked time
 * excludes them.
 */
export async function recordedCaptureDurationMs(endedAtMs: number): Promise<number | null> {
  const progress = await read();
  if (!progress) return null;
  const live = progress.runningSince != null ? Math.max(0, endedAtMs - progress.runningSince) : 0;
  const total = progress.recordedMs + live;
  return total > 0 ? total : null;
}

/**
 * Records that the run is accounted for. Called when the session reaches idle,
 * which a failed or discarded run reaches too — all three mean nothing is left
 * unclaimed in staging.
 */
export async function markCaptureSettled(): Promise<void> {
  await write(null);
}

/** True when a capture began and nothing has reported it finished. */
export async function captureMayBeUnsaved(): Promise<boolean> {
  return (await read()) !== null;
}

async function read(): Promise<CaptureProgress | null> {
  if (!hasLocalStorageArea()) return null;
  try {
    const stored = (await getLocalStorageValues(UNSAVED_CAPTURE_KEY))[UNSAVED_CAPTURE_KEY];
    if (!stored || typeof stored !== 'object') return null;
    const { recordedMs, runningSince } = stored as Partial<CaptureProgress>;
    if (typeof recordedMs !== 'number' || !Number.isFinite(recordedMs)) return null;
    return { recordedMs, runningSince: typeof runningSince === 'number' ? runningSince : null };
  } catch {
    // Unreadable is not the same as clean, but a scan we cannot decide to run
    // is better skipped than run on every open; the next launch asks again.
    return null;
  }
}

async function write(value: CaptureProgress | null): Promise<void> {
  if (!hasLocalStorageArea()) return;
  try {
    await setLocalStorageValues({ [UNSAVED_CAPTURE_KEY]: value });
  } catch {
    // Best-effort by design: this is bookkeeping, and failing it must never
    // take down the recording it is bookkeeping for.
  }
}
