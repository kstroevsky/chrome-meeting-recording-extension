/**
 * @file offscreen/engine/BitrateObserver.ts
 *
 * Rolling-window estimator of the *actual* encoded bitrate from MediaRecorder
 * chunk sizes. `MediaRecorder.videoBitsPerSecond` is only a hint the encoder may
 * ignore (hardware VBR paths in particular), so this measures what the encoder
 * really produced — making the gap between requested and delivered bitrate
 * observable in diagnostics. Observe-only: it never changes the recording.
 */

export type BitrateObservation = {
  /** Encoded bits per second measured across the rolling window. */
  actualBitsPerSecond: number;
  /** Span the estimate actually covers, in ms. */
  windowMs: number;
  /** Number of chunks the estimate is based on. */
  chunks: number;
};

export type BitrateObserverOptions = {
  /** How far back the rolling window reaches (ms). */
  windowMs?: number;
  /** Minimum spacing between emitted observations (ms). */
  emitIntervalMs?: number;
};

/**
 * Accumulates chunk sizes with arrival timestamps and yields an actual-bitrate
 * observation at most once per `emitIntervalMs`, measured over a trailing
 * `windowMs`. Pure and time-injected (`now` is passed in) so it is deterministic
 * to test.
 */
export class BitrateObserver {
  private readonly windowMs: number;
  private readonly emitIntervalMs: number;
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private lastEmitAt = 0;

  constructor(options: BitrateObserverOptions = {}) {
    this.windowMs = options.windowMs ?? 10_000;
    this.emitIntervalMs = options.emitIntervalMs ?? 10_000;
  }

  /**
   * Records an encoded chunk. Returns an observation when one is due (the emit
   * interval has elapsed and there is a measurable span), otherwise null.
   */
  record(bytes: number, now: number): BitrateObservation | null {
    this.samples.push({ at: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }

    // Throttle to one observation per interval (the first is always allowed).
    if (this.lastEmitAt !== 0 && now - this.lastEmitAt < this.emitIntervalMs) {
      return null;
    }
    // Need two samples to measure a span. The oldest sample marks the window
    // start, so its bytes belong to the previous interval and are excluded from
    // the numerator: rate = bytes that arrived *during* the span / span.
    if (this.samples.length < 2) return null;
    const spanMs = now - this.samples[0].at;
    if (spanMs <= 0) return null;

    let bytesInSpan = 0;
    for (let i = 1; i < this.samples.length; i += 1) {
      bytesInSpan += this.samples[i].bytes;
    }
    const actualBitsPerSecond = Math.round((bytesInSpan * 8) / (spanMs / 1000));
    this.lastEmitAt = now;
    return { actualBitsPerSecond, windowMs: Math.round(spanMs), chunks: this.samples.length };
  }
}
