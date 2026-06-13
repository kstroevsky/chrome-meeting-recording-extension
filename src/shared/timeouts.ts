/**
 * @file shared/timeouts.ts
 *
 * Centralised timeout and timing constants.
 *
 * Why a separate file?
 * Scattered magic numbers (4000, 8000, 15_000, 5_000) are hard to audit and
 * impossible to tune without grepping the whole codebase. Keeping them here means:
 *  - every timeout has a name that explains *why* it exists;
 *  - changing a value is a single-place edit;
 *  - code-reviewers can reason about timing policy in one glance.
 */

import { isE2EMockCaptureBuild } from './build';

const MEETING_END_GRACE_MS = isE2EMockCaptureBuild() ? 0 : 30_000;

export const TIMEOUTS = {
  /**
   * Maximum time we allow `getUserMedia()` to hang before we try the
   * fallback `chromeMediaSource` ('tab' → 'desktop').
   * 8 s is generous but tab-capture can legitimately take a few seconds
   * while Chrome negotiates the stream.
   */
  GUM_MS: 8_000,

  /**
   * How long the RPC client will wait for a response from the offscreen
   * document before rejecting the promise with a timeout error.
   * 15 s covers pathological cases (slow machine, heavy tab) while still
   * surfacing genuine hangs rather than waiting forever.
   */
  RPC_MS: 15_000,

  /**
   * Window given to `MediaRecorder.start()` to fire its `onstart` event.
   * If nothing happens in 4 s, the recorder silently failed to initialise.
   */
  RECORDER_START_MS: 4_000,

  /**
   * Grace period after the last caption update before a speaker's in-flight
   * utterance is "committed" to the final transcript.
   * 2 s matches a natural pause in speech without cutting off mid-sentence.
   */
  CAPTION_GRACE_MS: 2_000,

  /**
   * How long Meet must look ended before the content script asks background
   * to stop. This intentionally favors late stops over false auto-stops.
   */
  MEETING_END_GRACE_MS,

  /** Fallback polling cadence for meeting-end detection when DOM mutations are quiet. */
  MEETING_END_POLL_MS: 2_000,

  /**
   * Coalescing window for MeetingEndDetector's DOM-mutation observer. The
   * observer wakes on structural DOM changes (node add/remove) during a call;
   * bursts are collapsed to one evaluation per window so the doc-wide leave-call
   * querySelector does not re-run on every mutation. Detection latency is
   * unaffected — the 2 s poll backstop and 30 s grace own correctness. 0 in mock
   * builds so the e2e tier keeps deterministic, near-immediate end detection.
   */
  MEETING_END_OBSERVER_THROTTLE_MS: isE2EMockCaptureBuild() ? 0 : 500,

  /**
   * Maximum time ensureReady() will wait for the offscreen document to
   * connect its Port and signal OFFSCREEN_READY before giving up.
   * Uses a Promise-based signal (not polling) so the wait resolves
   * immediately when ready — this is just the outer safety net.
   */
  READY_TIMEOUT_MS: 5_000,

  /**
   * Base budget for sealing an OPFS recording — closing the sync handle and
   * running the in-worker WebM duration fix. A dead or silently-wedged worker
   * never replies `sealed`, so `close()` races this budget and fails fast instead
   * of hanging the whole stop in `stopping` forever. Generous on purpose: a false
   * abort only costs a re-run of the duration fix on next launch (the on-disk
   * bytes are already flushed and untouched by the read-only fix), never data.
   */
  SEAL_BASE_MS: 30_000,

  /**
   * Extra seal budget per MB written, so a legitimately-slow-but-progressing seal
   * of a multi-GB file on a slow disk is not falsely aborted (~10 MB/s floor).
   */
  SEAL_MS_PER_MB: 100,
} as const;
