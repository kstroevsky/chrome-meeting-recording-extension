/**
 * @file offscreen/storage/WriteBackpressure.ts
 *
 * Bounds the recorder's write queue. Chunks are dispatched to storage with
 * fire-and-forget writes that serialize in a promise chain; if the disk falls
 * behind, the un-written BlobEvents pile up in RAM (F9). This tracks in-flight
 * bytes/chunks and reacts in two stages:
 *   - a throttled soft warning once the backlog crosses the warn threshold, so
 *     a slow disk surfaces a clear warning instead of a silent OOM;
 *   - a single hard-ceiling escalation when the backlog grows past the point of
 *     recovery, so the caller can seal the already-persisted prefix rather than
 *     grow the queue unbounded toward an OOM crash.
 */

export type BackpressureInfo = {
  pendingBytes: number;
  pendingChunks: number;
  peakPendingBytes: number;
  warnCount: number;
};

export type WriteBackpressureLimits = {
  maxPendingBytes: number;
  maxPendingChunks: number;
  /** Hard ceiling: past this many unwritten bytes the backlog is unrecoverable. */
  maxPendingBytesHard: number;
  rewarnIntervalMs: number;
};

export type WriteBackpressureCallbacks = {
  /** Throttled soft warning: the disk is falling behind but the queue is bounded. */
  onWarn: (info: BackpressureInfo) => void;
  /** Fires once when the hard ceiling is breached; the caller should stop+seal. */
  onCeiling: (info: BackpressureInfo) => void;
};

// Conservative: a real fast-disk recording peaks at ~1 pending write, so these
// only trip when the disk genuinely cannot keep up. The hard ceiling sits well
// above the soft warn so the user gets a heads-up long before a protective stop.
export const DEFAULT_WRITE_BACKPRESSURE_LIMITS: WriteBackpressureLimits = {
  maxPendingBytes: 64 * 1024 * 1024, // 64 MB queued unwritten -> soft warn
  maxPendingChunks: 16,
  maxPendingBytesHard: 256 * 1024 * 1024, // 256 MB queued unwritten -> protective stop
  rewarnIntervalMs: 10_000,
};

export class WriteBackpressure {
  private pendingBytes = 0;
  private pendingChunks = 0;
  private peakPendingBytes = 0;
  private warnCount = 0;
  private lastWarnedAt = 0;
  private ceilingHit = false;

  constructor(
    private readonly callbacks: WriteBackpressureCallbacks,
    private readonly limits: WriteBackpressureLimits = DEFAULT_WRITE_BACKPRESSURE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Records a newly-dispatched (not-yet-written) chunk. Escalates once if the
   * backlog breaches the hard ceiling; otherwise warns (throttled) if it is over
   * the soft threshold.
   */
  enqueue(bytes: number): void {
    this.pendingBytes += bytes;
    this.pendingChunks += 1;
    if (this.pendingBytes > this.peakPendingBytes) this.peakPendingBytes = this.pendingBytes;

    // Past the hard ceiling the backlog is unrecoverable: escalate exactly once,
    // then stay silent — a protective stop is already in flight, so further soft
    // warnings would just be noise.
    if (this.ceilingHit) return;
    if (this.pendingBytes > this.limits.maxPendingBytesHard) {
      this.ceilingHit = true;
      this.callbacks.onCeiling(this.stats);
      return;
    }

    const overThreshold =
      this.pendingBytes > this.limits.maxPendingBytes
      || this.pendingChunks > this.limits.maxPendingChunks;
    if (!overThreshold) return;

    const at = this.now();
    if (this.warnCount > 0 && at - this.lastWarnedAt < this.limits.rewarnIntervalMs) return;
    this.lastWarnedAt = at;
    this.warnCount += 1;
    this.callbacks.onWarn(this.stats);
  }

  /** Records a completed (or failed) write; the bytes are no longer in flight. */
  complete(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
    this.pendingChunks = Math.max(0, this.pendingChunks - 1);
  }

  get stats(): BackpressureInfo {
    return {
      pendingBytes: this.pendingBytes,
      pendingChunks: this.pendingChunks,
      peakPendingBytes: this.peakPendingBytes,
      warnCount: this.warnCount,
    };
  }
}
