/**
 * @file offscreen/storage/WriteBackpressure.ts
 *
 * Bounds the recorder's write queue. Chunks are dispatched to storage with
 * fire-and-forget writes that serialize in a promise chain; if the disk falls
 * behind, the un-written BlobEvents pile up in RAM (F9). This tracks in-flight
 * bytes/chunks and fires a throttled warning when the backlog crosses a
 * threshold, so a slow disk surfaces a clear warning instead of a silent OOM.
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
  rewarnIntervalMs: number;
};

// Conservative: a real fast-disk recording peaks at ~1 pending write, so these
// only trip when the disk genuinely cannot keep up.
export const DEFAULT_WRITE_BACKPRESSURE_LIMITS: WriteBackpressureLimits = {
  maxPendingBytes: 64 * 1024 * 1024, // 64 MB queued unwritten
  maxPendingChunks: 16,
  rewarnIntervalMs: 10_000,
};

export class WriteBackpressure {
  private pendingBytes = 0;
  private pendingChunks = 0;
  private peakPendingBytes = 0;
  private warnCount = 0;
  private lastWarnedAt = 0;

  constructor(
    private readonly onWarn: (info: BackpressureInfo) => void,
    private readonly limits: WriteBackpressureLimits = DEFAULT_WRITE_BACKPRESSURE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records a newly-dispatched (not-yet-written) chunk; warns if the backlog is over threshold. */
  enqueue(bytes: number): void {
    this.pendingBytes += bytes;
    this.pendingChunks += 1;
    if (this.pendingBytes > this.peakPendingBytes) this.peakPendingBytes = this.pendingBytes;

    const overThreshold =
      this.pendingBytes > this.limits.maxPendingBytes
      || this.pendingChunks > this.limits.maxPendingChunks;
    if (!overThreshold) return;

    const at = this.now();
    if (this.warnCount > 0 && at - this.lastWarnedAt < this.limits.rewarnIntervalMs) return;
    this.lastWarnedAt = at;
    this.warnCount += 1;
    this.onWarn(this.stats);
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
