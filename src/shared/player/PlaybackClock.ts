/**
 * Shared multi-track playback clock used by both the extension player and the
 * public share viewer. The master owns the timeline; every auxiliary follows
 * its signed capture offset and only starts once its own timeline has begun.
 */

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

export const DRIFT_IGNORE_MS = 30;
export const DRIFT_RESYNC_MS = 150;

export type PlaybackClockOptions = {
  ignoreMs?: number;
  resyncMs?: number;
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
    this.syncAuxiliaryPlayback(track);
  }

  clear(): void {
    this.auxiliaries.length = 0;
  }

  /** Aligns auxiliaries to the master's current position without moving it. */
  syncFromMaster(): void {
    for (const track of this.auxiliaries) {
      this.alignOne(track);
      this.syncAuxiliaryPlayback(track);
    }
  }

  async play(): Promise<void> {
    for (const track of this.auxiliaries) this.alignOne(track);
    await this.master.play();
    await Promise.allSettled(this.auxiliaries.map((track) => this.syncAuxiliaryPlayback(track)));
  }

  pause(): void {
    this.master.pause();
    for (const track of this.auxiliaries) track.element.pause();
  }

  seek(ms: number): void {
    this.master.currentTime = Math.max(0, ms / 1000);
    this.syncFromMaster();
  }

  setPlaybackRate(rate: number): void {
    this.master.playbackRate = rate;
    for (const track of this.auxiliaries) track.element.playbackRate = rate;
  }

  correctDrift(): number {
    let resynced = 0;
    for (const track of this.auxiliaries) {
      if (!this.hasStarted(track)) {
        if (track.element.currentTime !== 0) track.element.currentTime = 0;
        if (!track.element.paused) track.element.pause();
        continue;
      }

      // Crossing a positive capture offset should start the auxiliary at its
      // own zero, rather than starting it early with the master.
      this.syncAuxiliaryPlayback(track);
      const drift = track.element.currentTime - this.targetFor(track);
      const magnitudeMs = Math.abs(drift) * 1000;
      if (magnitudeMs < this.ignoreMs) continue;
      if (magnitudeMs <= this.resyncMs) {
        this.options.onDrift?.(drift);
        continue;
      }
      this.alignOne(track);
      resynced += 1;
    }
    return resynced;
  }

  private targetFor(track: AuxiliaryTrack): number {
    return Math.max(0, this.master.currentTime - track.timelineOffsetMs / 1000);
  }

  private hasStarted(track: AuxiliaryTrack): boolean {
    return this.master.currentTime * 1000 >= track.timelineOffsetMs;
  }

  private alignOne(track: AuxiliaryTrack): void {
    track.element.currentTime = this.targetFor(track);
    track.element.playbackRate = this.master.playbackRate;
  }

  private syncAuxiliaryPlayback(track: AuxiliaryTrack): Promise<void> {
    if (this.master.paused || !this.hasStarted(track)) {
      if (!track.element.paused) track.element.pause();
      return Promise.resolve();
    }
    if (!track.element.paused) return Promise.resolve();
    this.alignOne(track);
    return track.element.play().catch(() => undefined);
  }
}
