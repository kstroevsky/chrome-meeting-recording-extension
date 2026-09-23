import type { RecordingSessionSnapshot } from '../../../shared/recording';
import { elapsedRecordedMs } from './RecordingClock';

export type RunEnding = 'kept' | 'discarded';
export type RunFinishedListener = (
  historyId: string,
  durationMs: number,
  ending: RunEnding,
) => void;

/** Owns the finished-run memory and corrections that can arrive after terminal state. */
export class RecordingRunFinalization {
  private lastRun?: { historyId: string; durationMs: number; ending: RunEnding };
  private onRunFinished?: RunFinishedListener;

  constructor(onRunFinished?: RunFinishedListener) {
    this.onRunFinished = onRunFinished;
  }

  bind(onRunFinished?: RunFinishedListener): void {
    this.onRunFinished = onRunFinished;
  }

  remember(snapshot: RecordingSessionSnapshot, now: number, ending: RunEnding): void {
    const { historyId } = snapshot;
    if (!historyId) return;
    const alreadyAnnounced = this.lastRun?.historyId === historyId;
    const durationMs = alreadyAnnounced
      ? this.lastRun!.durationMs
      : elapsedRecordedMs(snapshot, now);
    this.lastRun = { historyId, durationMs, ending };
    if (!alreadyAnnounced) this.onRunFinished?.(historyId, durationMs, ending);
  }

  finishedDuration(historyId: string): number | undefined {
    return this.lastRun?.historyId === historyId ? this.lastRun.durationMs : undefined;
  }

  markBackgroundFinalized(
    snapshot: RecordingSessionSnapshot,
    historyId: string,
    now: number,
  ): RecordingSessionSnapshot {
    if (snapshot.finalization?.historyId !== historyId) return snapshot;
    return {
      ...snapshot,
      finalization: { ...snapshot.finalization, backgroundFinalized: true },
      updatedAt: now,
    };
  }

  reconcileDisposition(
    snapshot: RecordingSessionSnapshot,
    historyId: string,
    epoch: number,
    disposition: RunEnding,
    now: number,
  ): RecordingSessionSnapshot {
    const finalization = snapshot.finalization;
    if (
      finalization?.historyId !== historyId
      || finalization.epoch !== epoch
      || finalization.disposition === disposition
    ) return snapshot;

    if (
      disposition === 'kept'
      && this.lastRun?.historyId === historyId
      && this.lastRun.ending === 'discarded'
    ) {
      this.lastRun = { ...this.lastRun, ending: 'kept' };
      this.onRunFinished?.(historyId, this.lastRun.durationMs, 'kept');
    }
    return {
      ...snapshot,
      finalization: { ...finalization, disposition },
      updatedAt: now,
    };
  }
}
