import { RecordingSession } from '../recording/session/RecordingSession';
import type { RecordingRunConfig } from '../../shared/recording';

const RUN_CONFIG: RecordingRunConfig = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

describe('RecordingSession state machine', () => {
  let persist: jest.Mock;
  let onChanged: jest.Mock;
  let session: RecordingSession;

  beforeEach(() => {
    persist = jest.fn();
    onChanged = jest.fn();
    session = new RecordingSession(persist, onChanged);
  });

  it('starts idle with no run configuration', () => {
    const snapshot = session.getSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.runConfig).toBeNull();
  });

  it('returns a defensive clone from getSnapshot', () => {
    session.start(RUN_CONFIG, { targetTabId: 7 });
    const a = session.getSnapshot();
    (a.runConfig as any).micMode = 'mutated';
    expect(session.getSnapshot().runConfig?.micMode).toBe('separate');
  });

  it('enters the starting phase and records the target tab and meeting', async () => {
    const snapshot = session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });

    expect(snapshot.phase).toBe('starting');
    expect(snapshot.runConfig).toEqual(RUN_CONFIG);
    expect(snapshot.targetTabId).toBe(42);
    expect(snapshot.meetingSlug).toBe('abc-defg-hij');
    await session.flush();
    expect(persist).toHaveBeenCalledWith(snapshot);
    expect(onChanged).toHaveBeenCalledWith(snapshot);
  });

  it('preserves run config and target across simple phase transitions', () => {
    session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });

    const recording = session.applyOffscreenPhase({ phase: 'recording' });
    expect(recording.phase).toBe('recording');
    expect(recording.runConfig).toEqual(RUN_CONFIG);
    expect(recording.targetTabId).toBe(42);
    expect(recording.meetingSlug).toBe('abc-defg-hij');

    const stopping = session.markStopping();
    expect(stopping.phase).toBe('stopping');
    expect(stopping.runConfig).toEqual(RUN_CONFIG);

    // A same-run idle is a genuine end-of-run; the run config is cleared on idle.
    const idle = session.applyOffscreenPhase({ phase: 'idle' });
    expect(idle.phase).toBe('idle');
  });

  it('clears run state and carries the upload summary on markIdle', () => {
    session.start(RUN_CONFIG, { targetTabId: 42 });
    const summary = { uploaded: [{ stream: 'tab' as const, filename: 'tab.webm' }], localFallbacks: [] };

    const idle = session.markIdle(summary, ['done with warnings']);

    expect(idle.phase).toBe('idle');
    expect(idle.runConfig).toBeNull();
    expect(idle.targetTabId).toBeUndefined();
    expect(idle.uploadSummary).toEqual(summary);
    expect(idle.warnings).toEqual(['done with warnings']);
  });

  it('fail() preserves the last run config, target, and warnings', () => {
    session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });
    session.applyOffscreenPhase({ phase: 'recording' });

    const failed = session.fail('boom');

    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.runConfig).toEqual(RUN_CONFIG);
    expect(failed.targetTabId).toBe(42);
    expect(failed.meetingSlug).toBe('abc-defg-hij');
  });

  it('allows restarting from a failed session', () => {
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.fail('boom');

    const restarted = session.start({ ...RUN_CONFIG, storageMode: 'local' }, { targetTabId: 99 });

    expect(restarted.phase).toBe('starting');
    expect(restarted.runConfig?.storageMode).toBe('local');
    expect(restarted.targetTabId).toBe(99);
    expect(restarted.error).toBeUndefined();
  });

  it('commits (persists + notifies) on every transition', async () => {
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    session.markStopping();

    await session.flush();
    expect(persist).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it('flushes writes in order and exposes a persistence failure to durable callers', async () => {
    const writeFailure = new Error('session storage unavailable');
    persist.mockRejectedValueOnce(writeFailure);

    session.start(RUN_CONFIG, { targetTabId: 42 });

    await expect(session.flush()).rejects.toThrow('session storage unavailable');
  });

  describe('run epoch (fencing token, ADR-0003)', () => {
    it('assigns a fresh, strictly increasing epoch per run and preserves it across transitions and idle', () => {
      expect(session.start(RUN_CONFIG).epoch).toBe(1);
      // Preserved through the run so every status the offscreen echoes matches.
      expect(session.applyOffscreenPhase({ phase: 'recording' }).epoch).toBe(1);
      expect(session.markStopping().epoch).toBe(1);
      // Preserved across idle so the next run is strictly greater (not reset to 1).
      expect(session.markIdle().epoch).toBe(1);

      expect(session.start(RUN_CONFIG).epoch).toBe(2);
      // failed preserves the active run's epoch; a retry start increments again.
      expect(session.fail('boom').epoch).toBe(2);
      expect(session.start(RUN_CONFIG).epoch).toBe(3);
    });

    it('rehydrates the persisted epoch so the fence survives a service-worker restart', () => {
      const restored = session.hydrate({ phase: 'recording', runConfig: RUN_CONFIG, epoch: 5, updatedAt: 1 });
      expect(restored.epoch).toBe(5);
      // The next run continues strictly above the restored epoch.
      expect(session.start(RUN_CONFIG).epoch).toBe(6);
    });
  });

  describe('desired/observed planes (ADR-0003 Decision 4)', () => {
    it('derives phase from the two planes and lets only the command path change intent', () => {
      const starting = session.start(RUN_CONFIG, { targetTabId: 42 });
      expect(starting.desired).toBe('recording');
      expect(starting.observed).toBe('starting');
      expect(starting.phase).toBe('starting');

      // Observation writes `observed` only — it must never touch `desired`.
      const recording = session.applyOffscreenPhase({ phase: 'recording' });
      expect(recording.desired).toBe('recording');
      expect(recording.observed).toBe('recording');
      expect(recording.phase).toBe('recording');

      // The command path is the only writer of intent.
      const stopping = session.markStopping();
      expect(stopping.desired).toBe('idle');
      expect(stopping.observed).toBe('recording');
      expect(stopping.phase).toBe('stopping');
    });

    it('does NOT let a late same-run recording re-broadcast clobber a stop in progress', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      expect(session.markStopping().phase).toBe('stopping');

      // A late same-run `recording` report (e.g. an offscreen reconnect re-broadcast)
      // lands after the stop. Pre-Decision-4 it flipped the phase back to `recording`;
      // now intent (`desired=idle`) is preserved and the phase stays `stopping`.
      const afterLate = session.applyOffscreenPhase({ phase: 'recording' });
      expect(afterLate.phase).toBe('stopping');
      expect(afterLate.desired).toBe('idle');
      expect(afterLate.observed).toBe('recording');
    });
  });

  describe('applyOffscreenPhase', () => {
    it('retains delivered microphone and camera labels for the active run', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });

      const starting = session.applyOffscreenPhase({
        phase: 'starting',
        capturedDevices: { microphone: 'Shure MV7' },
      });
      expect(starting.capturedDevices).toEqual({ microphone: 'Shure MV7' });

      const recording = session.applyOffscreenPhase({
        phase: 'recording',
        capturedDevices: { microphone: 'Shure MV7', camera: 'Logitech Brio' },
      });
      expect(recording.capturedDevices).toEqual({ microphone: 'Shure MV7', camera: 'Logitech Brio' });
      expect(session.markStopping().capturedDevices).toEqual({ microphone: 'Shure MV7', camera: 'Logitech Brio' });
      expect(session.applyOffscreenPhase({ phase: 'idle' }).capturedDevices).toBeUndefined();
    });

    it('finalizes through markIdle on an offscreen idle report, surfacing the upload summary', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      const summary = { uploaded: [], localFallbacks: [{ stream: 'tab' as const, filename: 'tab.webm', error: 'x' }] };

      // A same-run idle (a commanded stop OR an autonomous offscreen finalize) ends
      // the run regardless of intent — cross-run stale idle is fenced out before here.
      const snapshot = session.applyOffscreenPhase({ phase: 'idle', uploadSummary: summary, warnings: ['w'] });

      expect(snapshot.phase).toBe('idle');
      expect(snapshot.runConfig).toBeNull();
      expect(snapshot.uploadSummary).toEqual(summary);
      expect(snapshot.warnings).toEqual(['w']);
    });

    it('routes a failed update through fail with a default error message', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });

      const snapshot = session.applyOffscreenPhase({ phase: 'failed', warnings: ['late warning'] });

      expect(snapshot.phase).toBe('failed');
      expect(snapshot.error).toBe('Recording runtime failed');
      expect(snapshot.warnings).toEqual(['late warning']);
      expect(snapshot.runConfig).toEqual(RUN_CONFIG);
    });

    it('applies an intermediate phase, preserving run config and clearing the upload summary', () => {
      session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });
      session.markIdle({ uploaded: [], localFallbacks: [] }); // leaves a stale summary in history
      session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });

      const snapshot = session.applyOffscreenPhase({ phase: 'recording', warnings: ['w'] });

      expect(snapshot.phase).toBe('recording');
      expect(snapshot.runConfig).toEqual(RUN_CONFIG);
      expect(snapshot.targetTabId).toBe(42);
      expect(snapshot.uploadSummary).toBeUndefined();
      expect(snapshot.warnings).toEqual(['w']);
    });
  });

  describe('hydrate', () => {
    it('falls back to an idle snapshot for non-record input', async () => {
      const snapshot = session.hydrate(null);
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.runConfig).toBeNull();
      await session.flush();
      expect(persist).toHaveBeenCalledWith(snapshot);
    });

    it('normalizes and adopts a persisted active snapshot', () => {
      const snapshot = session.hydrate({
        phase: 'recording',
        runConfig: { storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true },
        targetTabId: 5,
        meetingSlug: 'abc-defg-hij',
        updatedAt: 123,
      });

      expect(snapshot.phase).toBe('recording');
      expect(snapshot.runConfig).toEqual({ storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true, tabContentType: 'screen' });
      expect(snapshot.targetTabId).toBe(5);
      expect(snapshot.meetingSlug).toBe('abc-defg-hij');
      // Hydration becomes the live state.
      expect(session.getSnapshot().phase).toBe('recording');
    });
  });

  describe('mic mute', () => {
    it('sets micMuted to true and clears it (never stores false)', async () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });

      expect(session.setMicMuted(true).micMuted).toBe(true);
      await session.flush();
      expect(persist).toHaveBeenCalled();
      expect(session.setMicMuted(false).micMuted).toBeUndefined();
    });

    it('preserves micMuted across transitions and offscreen re-broadcasts', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      session.setMicMuted(true);

      expect(session.markStopping().micMuted).toBe(true);
      // A late offscreen phase push (e.g. a warning) must not wipe the flag.
      expect(session.applyOffscreenPhase({ phase: 'recording', warnings: ['w'] }).micMuted).toBe(true);
    });

    it('clears micMuted when the session returns to idle', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.setMicMuted(true);

      expect(session.markIdle().micMuted).toBeUndefined();
    });
  });

  describe('camera hide', () => {
    it('sets cameraMuted true and clears it (never false), independent of micMuted', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.setMicMuted(true);

      expect(session.setCameraMuted(true).cameraMuted).toBe(true);
      expect(session.getSnapshot().micMuted).toBe(true); // mic flag untouched
      expect(session.setCameraMuted(false).cameraMuted).toBeUndefined();
    });

    it('preserves cameraMuted across transitions and offscreen re-broadcasts', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      session.setCameraMuted(true);

      expect(session.markStopping().cameraMuted).toBe(true);
      expect(session.applyOffscreenPhase({ phase: 'recording', warnings: ['w'] }).cameraMuted).toBe(true);
    });

    it('clears cameraMuted when the session returns to idle', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.setCameraMuted(true);

      expect(session.markIdle().cameraMuted).toBeUndefined();
    });
  });

  describe('pause', () => {
    it('sets paused true and clears it (never stores false), independent of mute flags', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.setMicMuted(true);

      expect(session.setPaused(true).paused).toBe(true);
      expect(session.getSnapshot().micMuted).toBe(true); // mute flags untouched
      expect(session.setPaused(false).paused).toBeUndefined();
    });

    it('preserves paused across transitions and offscreen re-broadcasts', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      session.setPaused(true);

      expect(session.markStopping().paused).toBe(true);
      expect(session.applyOffscreenPhase({ phase: 'recording', warnings: ['w'] }).paused).toBe(true);
      expect(session.fail('boom').paused).toBe(true);
    });

    it('clears paused when the session returns to idle', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.setPaused(true);

      expect(session.markIdle().paused).toBeUndefined();
    });
  });

});
