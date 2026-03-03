/**
 * @file shared/timeouts.ts
 *
 * Centralised timeout and timing constants.
 *
 * Why a separate file?
 * Scattered magic numbers (4000, 8000, 15_000, 100) are hard to audit and
 * impossible to tune without grepping the whole codebase. Keeping them here means:
 *  - every timeout has a name that explains *why* it exists;
 *  - changing a value is a single-place edit;
 *  - code-reviewers can reason about timing policy in one glance.
 */

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
   * Sleep between individual polls while waiting for the offscreen document
   * to become ready. Kept short so UI doesn't feel sluggish on fast machines.
   */
  READY_POLL_INTERVAL_MS: 100,

  /**
   * Maximum number of poll iterations in each offscreen-ready waiting loop.
   * 10 iterations × 100 ms = 1 s ceiling for the first (PING) loop.
   */
  READY_POLL_PING_MAX: 10,

  /**
   * Maximum number of poll iterations after sending OFFSCREEN_CONNECT.
   * 50 iterations × 100 ms = 5 s ceiling — enough for slow cold-starts.
   */
  READY_POLL_CONNECT_MAX: 50,
} as const;
