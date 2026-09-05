/**
 * @file recordings/player/PlaybackClock.ts
 *
 * Keeps auxiliary tracks on the tab track's clock (ADR-0006 §21).
 *
 * Three independently-started `MediaRecorder`s produce three files that are
 * *close* to aligned but not identical, and three media elements left to their
 * own devices drift apart besides. One element is the master — the tab capture,
 * because it is the picture — and the rest follow it.
 *
 * Correction is deliberately reluctant. Seeking an element is audible, so a
 * small error is left alone rather than papered over with a constant stream of
 * micro-seeks that would sound far worse than the drift.
 */

/** The part of a media element this needs; keeps it testable without the DOM. */
export type ClockElement = {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
};

export type AuxiliaryTrack = {
  element: ClockElement;
  /** Signed offset of this track's first sample against the master's. */
  timelineOffsetMs: number;
};

/**
 * Drift bands. Below `ignoreMs` a correction would be more disruptive than the
 * error; above `resyncMs` the tracks are audibly apart and a hard seek is worth
 * it. Between the two we watch rather than act.
 */
export const DRIFT_IGNORE_MS = 30;
export const DRIFT_RESYNC_MS = 150;

export type PlaybackClockOptions = {
  ignoreMs?: number;
  resyncMs?: number;
  /** Reports observed drift in the watch band, for diagnostics. */
  onDrift?: (seconds: number) => void;
};

export class PlaybackClock {
  private readonly auxiliaries: AuxiliaryTrack[] = [];
  private readonly ignoreMs: number;
  private readonly resyncMs: number;

  constructor(private readonly master: ClockElement, private readonly options: PlaybackClockOptions = {}) {
    this.ignoreMs = options.ignoreMs ?? DRIFT_IGNORE_MS;
    this.resyncMs = options.resyncMs ?? DRIFT_RESYNC_MS;
  }

  add(track: AuxiliaryTrack): void {
    this.auxiliaries.push(track);
    this.alignOne(track);
  }

  clear(): void {
    this.auxiliaries.length = 0;
  }

  /** Where an auxiliary should be, given where the master is. Never negative. */
  private targetFor(track: AuxiliaryTrack): number {
    return Math.max(0, this.master.currentTime - track.timelineOffsetMs / 1000);
  }

  private alignOne(track: AuxiliaryTrack): void {
    track.element.currentTime = this.targetFor(track);
    track.element.playbackRate = this.master.playbackRate;
  }

  /**
   * Starts every track. An auxiliary that refuses to play (still buffering, or
   * a decode error) must not take the master down with it — `Promise.all` would
   * reject on the first failure and leave the whole player silent, which is how
   * a broken mic track stopped the video from playing at all.
   */
  async play(): Promise<void> {
    // Align before starting, or every track begins from wherever it was paused.
    for (const track of this.auxiliaries) this.alignOne(track);
    await this.master.play();
    await Promise.allSettled(this.auxiliaries.map((track) => track.element.play()));
  }

  pause(): void {
    this.master.pause();
    for (const track of this.auxiliaries) track.element.pause();
  }

  /** Seeks everything. `ms` is a position on the master's timeline. */
  seek(ms: number): void {
    this.master.currentTime = Math.max(0, ms / 1000);
    for (const track of this.auxiliaries) this.alignOne(track);
  }

  setPlaybackRate(rate: number): void {
    this.master.playbackRate = rate;
    for (const track of this.auxiliaries) track.element.playbackRate = rate;
  }

  /**
   * Called periodically while playing. Returns how many tracks were resynced,
   * which is the number worth alarming on if it keeps growing.
   */
  correctDrift(): number {
    let resynced = 0;
    for (const track of this.auxiliaries) {
      const drift = track.element.currentTime - this.targetFor(track);
      const magnitudeMs = Math.abs(drift) * 1000;
      if (magnitudeMs < this.ignoreMs) continue;
      if (magnitudeMs <= this.resyncMs) {
        // Watch band: report it, but a seek here would be more audible than the drift.
        this.options.onDrift?.(drift);
        continue;
      }
      this.alignOne(track);
      resynced += 1;
    }
    return resynced;
  }
}
