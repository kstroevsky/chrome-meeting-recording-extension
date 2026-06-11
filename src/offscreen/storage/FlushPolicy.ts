/**
 * @file offscreen/storage/FlushPolicy.ts
 *
 * Decides when the OPFS sync-access worker should `flush()` written bytes to
 * disk.
 *
 * The worker appends each chunk synchronously, but `flush()` — which forces the
 * OS to persist the data — is comparatively expensive, so we do NOT flush on
 * every write. Flushing only at `close()` (the original behavior) means a hard
 * power cut can lose everything still sitting in the OS page cache. This policy
 * bounds that at-risk window: it reports a flush as due at most once per
 * `intervalMs` of elapsed wall-clock time, so on a power cut you lose at most
 * ~`intervalMs` of recording rather than the whole unflushed tail.
 *
 * `now` is injected on every call so the policy is deterministic and
 * unit-testable without timers.
 */

export const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

export class FlushPolicy {
  private lastFlushAt: number;

  constructor(now: number, private readonly intervalMs: number = DEFAULT_FLUSH_INTERVAL_MS) {
    this.lastFlushAt = now;
  }

  /**
   * Call after each write with the current time. Returns `true` when at least
   * one interval has elapsed since the last flush, and resets the interval clock
   * so a burst of writes coalesces into a single flush per window.
   */
  onWrite(now: number): boolean {
    if (now - this.lastFlushAt >= this.intervalMs) {
      this.lastFlushAt = now;
      return true;
    }
    return false;
  }
}
