import { createPhaseWatchdog } from '../src/background/phaseWatchdog';
import type { RecordingPhase, RecordingSessionSnapshot } from '../src/shared/recording';

function snap(phase: RecordingPhase, updatedAt: number): RecordingSessionSnapshot {
  return { phase, runConfig: null, updatedAt };
}

describe('phaseWatchdog', () => {
  const BUDGET = 30_000;
  let nowMs: number;
  let pending: { cb: () => void; ms: number } | null;
  let onStuck: jest.Mock;
  let snapshot: RecordingSessionSnapshot;

  const makeWatchdog = () =>
    createPhaseWatchdog({
      budgetMs: BUDGET,
      now: () => nowMs,
      getSnapshot: () => snapshot,
      onStuck,
      setTimer: (cb, ms) => { pending = { cb, ms }; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { pending = null; },
    });

  /** Invokes the armed timer callback, mirroring the runtime firing it. */
  const fire = () => { const p = pending; pending = null; p?.cb(); };

  beforeEach(() => {
    nowMs = 1_000_000;
    pending = null;
    onStuck = jest.fn();
    snapshot = snap('idle', nowMs);
  });

  it('arms for the full budget on entering starting and fires onStuck if still starting', () => {
    const wd = makeWatchdog();
    snapshot = snap('starting', nowMs);
    wd.observe(snapshot);
    expect(pending?.ms).toBe(BUDGET);

    fire();
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck).toHaveBeenCalledWith(snapshot);
  });

  it('clears the timer when the phase transitions away from starting', () => {
    const wd = makeWatchdog();
    wd.observe(snap('starting', nowMs));
    expect(pending).not.toBeNull();
    wd.observe(snap('recording', nowMs));
    expect(pending).toBeNull();
  });

  it('does not arm for any non-starting phase', () => {
    const wd = makeWatchdog();
    for (const phase of ['idle', 'recording', 'stopping', 'uploading', 'failed'] as const) {
      wd.observe(snap(phase, nowMs));
      expect(pending).toBeNull();
    }
  });

  it('fires immediately (zero remaining) for a stale starting rehydrated after a SW restart', () => {
    const wd = makeWatchdog();
    snapshot = snap('starting', nowMs - BUDGET - 5_000); // already past the budget
    wd.observe(snapshot);
    expect(pending?.ms).toBe(0);

    fire();
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('grants only the remaining budget for a partially-elapsed starting', () => {
    const wd = makeWatchdog();
    wd.observe(snap('starting', nowMs - 10_000));
    expect(pending?.ms).toBe(BUDGET - 10_000);
  });

  it('does not call onStuck if the session left starting before the timer fires', () => {
    const wd = makeWatchdog();
    wd.observe(snap('starting', nowMs));
    snapshot = snap('recording', nowMs); // moved on; fire the stale callback anyway
    fire();
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('stop() cancels a pending timer', () => {
    const wd = makeWatchdog();
    wd.observe(snap('starting', nowMs));
    wd.stop();
    expect(pending).toBeNull();
  });
});
