/**
 * @file background/unsavedCaptureFlag.ts
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
 */

import { getLocalStorageValues, hasLocalStorageArea, setLocalStorageValues } from '../platform/chrome/storage';

const UNSAVED_CAPTURE_KEY = 'captureMayBeUnsaved';

/** Records that capture has begun, so a crash from here on is detectable. */
export async function markCaptureStarted(): Promise<void> {
  await setFlag(true);
}

/**
 * Records that the run is accounted for. Called when the session reaches idle,
 * which a failed or discarded run reaches too — all three mean nothing is left
 * unclaimed in staging.
 */
export async function markCaptureSettled(): Promise<void> {
  await setFlag(false);
}

/** True when a capture began and nothing has reported it finished. */
export async function captureMayBeUnsaved(): Promise<boolean> {
  if (!hasLocalStorageArea()) return false;
  try {
    const stored = await getLocalStorageValues(UNSAVED_CAPTURE_KEY);
    return stored[UNSAVED_CAPTURE_KEY] === true;
  } catch {
    // Unreadable is not the same as clean, but a scan we cannot decide to run
    // is better skipped than run on every open; the next launch asks again.
    return false;
  }
}

async function setFlag(value: boolean): Promise<void> {
  if (!hasLocalStorageArea()) return;
  try {
    await setLocalStorageValues({ [UNSAVED_CAPTURE_KEY]: value });
  } catch {
    // Best-effort by design: this is bookkeeping, and failing it must never
    // take down the recording it is bookkeeping for.
  }
}
