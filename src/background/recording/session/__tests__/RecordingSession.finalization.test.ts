import { RecordingSession } from '../RecordingSession';
import type { RecordingRunConfig } from '../../../../shared/recording';

const RUN_CONFIG: RecordingRunConfig = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

describe('RecordingSession run finalization', () => {
  let persist: jest.Mock;
  let onChanged: jest.Mock;
  let session: RecordingSession;
  let nowSpy: jest.SpyInstance;
  let t: number;

  beforeEach(() => {
    persist = jest.fn();
    onChanged = jest.fn();
    session = new RecordingSession(persist, onChanged);
    t = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => t);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  describe('recording timer', () => {
    describe('interruption notice (design n4)', () => {
      it('records what ended the run, where it reached, and which recording it made', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = session.getSnapshot().historyId!;
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 401_000;
        session.markStopping('tab-closed');

        expect(session.getSnapshot().interruption)
          .toEqual({ reason: 'tab-closed', atMs: 401_000, historyId });
      });

      it('outlives the run, because the capture is already saved', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 5_000;
        session.markStopping('navigated-away');
        session.applyOffscreenPhase({ phase: 'idle' });

        expect(session.getSnapshot().phase).toBe('idle');
        expect(session.getSnapshot().interruption?.reason).toBe('navigated-away');
      });

      it('says nothing when the user stopped the recording themselves', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 5_000;
        session.markStopping();

        expect(session.getSnapshot().interruption).toBeUndefined();
      });

      it('clears on dismissal and on the next run', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        session.markStopping('tab-closed');
        session.applyOffscreenPhase({ phase: 'idle' });

        expect(session.dismissInterruption().interruption).toBeUndefined();

        session.start(RUN_CONFIG, { targetTabId: 43 });
        session.applyOffscreenPhase({ phase: 'recording' });
        session.markStopping('tab-closed');
        session.applyOffscreenPhase({ phase: 'idle' });
        expect(session.getSnapshot().interruption).toBeDefined();
        session.start(RUN_CONFIG, { targetTabId: 44 });
        expect(session.getSnapshot().interruption).toBeUndefined();
      });
    });

    describe('onRunFinished (sealing what the run left open, ADR-0005)', () => {
      const withHook = () => {
        const onRunFinished = jest.fn();
        return { onRunFinished, hooked: new RecordingSession(persist, onChanged, onRunFinished) };
      };

      it('announces the run once, with its final pause-aware duration', () => {
        const { onRunFinished, hooked } = withHook();
        hooked.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = hooked.getSnapshot().historyId!;
        hooked.applyOffscreenPhase({ phase: 'recording' });

        t += 4_000;
        hooked.setPaused(true);
        t += 6_000;
        hooked.setPaused(false);
        t += 2_000;
        hooked.markStopping();
        hooked.applyOffscreenPhase({ phase: 'idle' });

        expect(onRunFinished).toHaveBeenCalledTimes(1);
        expect(onRunFinished).toHaveBeenCalledWith(historyId, 6_000, 'kept');
      });

      it('announces a run that ended in failure', () => {
        const { onRunFinished, hooked } = withHook();
        hooked.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = hooked.getSnapshot().historyId!;
        hooked.applyOffscreenPhase({ phase: 'recording' });
        t += 3_000;
        hooked.fail('the meeting tab closed');

        // A failure is not a discard: whatever the run produced may still be delivered.
        expect(onRunFinished).toHaveBeenCalledWith(historyId, 3_000, 'kept');
      });

      it('says when the run being announced is a discard', () => {
        // Finalization intent is durable at markStopping, but the hook waits
        // for the offscreen idle acknowledgement before announcing the run.
        const { onRunFinished, hooked } = withHook();
        hooked.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = hooked.getSnapshot().historyId!;
        hooked.applyOffscreenPhase({ phase: 'recording' });

        t += 2_000;
        hooked.markStopping(undefined, 'discarded');

        expect(onRunFinished).not.toHaveBeenCalled();
        hooked.applyOffscreenPhase({ phase: 'idle' });
        expect(onRunFinished).toHaveBeenCalledTimes(1);
        expect(onRunFinished).toHaveBeenCalledWith(historyId, 2_000, 'discarded');
      });

      it('announces after offscreen idle while preserving the markStopping cutoff', () => {
        const { onRunFinished, hooked } = withHook();
        hooked.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = hooked.getSnapshot().historyId!;
        hooked.applyOffscreenPhase({ phase: 'recording' });

        t += 9_000;
        hooked.markStopping();

        expect(onRunFinished).not.toHaveBeenCalled();

        // Offscreen confirmation announces the run, but does not extend the
        // logical duration past the user-command cutoff.
        t += 4_000;
        hooked.applyOffscreenPhase({ phase: 'idle' });
        expect(onRunFinished).toHaveBeenCalledTimes(1);
        expect(onRunFinished).toHaveBeenCalledWith(historyId, 9_000, 'kept');
        expect(hooked.runDurationMs(historyId)).toBe(9_000);
      });

      it('does not re-announce a run that already finished', () => {
        const { onRunFinished, hooked } = withHook();
        hooked.start(RUN_CONFIG, { targetTabId: 42 });
        hooked.applyOffscreenPhase({ phase: 'recording' });
        t += 1_000;
        hooked.applyOffscreenPhase({ phase: 'idle' });
        hooked.applyOffscreenPhase({ phase: 'idle' });
        hooked.markIdle();

        expect(onRunFinished).toHaveBeenCalledTimes(1);
      });

      it('stays silent when there was never a run to finish', () => {
        const { onRunFinished, hooked } = withHook();
        hooked.markIdle();
        expect(onRunFinished).not.toHaveBeenCalled();
      });
    });

    describe('runDurationMs (the history row\u2019s durationMs)', () => {
      it('reports the live duration while the run is still in flight', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = session.getSnapshot().historyId!;
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 9_000;
        expect(session.runDurationMs(historyId)).toBe(9_000);
      });

      it('survives the return to idle, when the history row is usually created', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = session.getSnapshot().historyId!;
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 5_000;
        session.setPaused(true);
        t += 10_000;
        session.setPaused(false);
        t += 3_000;
        session.markStopping();
        session.applyOffscreenPhase({ phase: 'idle' });

        // The snapshot has dropped both historyId and recordedMs by now...
        expect(session.getSnapshot().historyId).toBeUndefined();
        expect(session.getSnapshot().recordedMs).toBeUndefined();
        // ...but the finished run's duration is still answerable, and it
        // excludes the 10s pause.
        expect(session.runDurationMs(historyId)).toBe(8_000);
      });

      it('survives a terminal failure', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        const historyId = session.getSnapshot().historyId!;
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 4_000;
        session.fail('recorder died');

        expect(session.runDurationMs(historyId)).toBe(4_000);
      });

      it('survives into the next run, so a late row from the previous one still resolves', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        const first = session.getSnapshot().historyId!;
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 6_000;
        session.markStopping();
        session.applyOffscreenPhase({ phase: 'idle' });

        session.start(RUN_CONFIG, { targetTabId: 43 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 1_000;

        expect(session.runDurationMs(first)).toBe(6_000);
        expect(session.runDurationMs(session.getSnapshot().historyId!)).toBe(1_000);
      });

      it('returns undefined for an unknown or missing run', () => {
        expect(session.runDurationMs('recording:never-seen')).toBeUndefined();
        expect(session.runDurationMs(undefined)).toBeUndefined();
      });
    });
  });
});
