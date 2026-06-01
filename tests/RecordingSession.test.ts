import { RecordingSession } from '../src/background/RecordingSession';
import type { RecordingRunConfig } from '../src/shared/recording';

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

  it('enters the starting phase and records the target tab and meeting', () => {
    const snapshot = session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });

    expect(snapshot.phase).toBe('starting');
    expect(snapshot.runConfig).toEqual(RUN_CONFIG);
    expect(snapshot.targetTabId).toBe(42);
    expect(snapshot.meetingSlug).toBe('abc-defg-hij');
    expect(persist).toHaveBeenCalledWith(snapshot);
    expect(onChanged).toHaveBeenCalledWith(snapshot);
  });

  it('preserves run config and target across simple phase transitions', () => {
    session.start(RUN_CONFIG, { targetTabId: 42, meetingSlug: 'abc-defg-hij' });

    const recording = session.markRecording();
    expect(recording.phase).toBe('recording');
    expect(recording.runConfig).toEqual(RUN_CONFIG);
    expect(recording.targetTabId).toBe(42);
    expect(recording.meetingSlug).toBe('abc-defg-hij');

    const stopping = session.markStopping();
    expect(stopping.phase).toBe('stopping');
    expect(stopping.runConfig).toEqual(RUN_CONFIG);

    const uploading = session.markUploading();
    expect(uploading.phase).toBe('uploading');
    expect(uploading.runConfig).toEqual(RUN_CONFIG);
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
    session.markRecording();

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

  it('commits (persists + notifies) on every transition', () => {
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.markRecording();
    session.markStopping();

    expect(persist).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  describe('applyOffscreenPhase', () => {
    it('routes an idle update through markIdle with its summary and warnings', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      const summary = { uploaded: [], localFallbacks: [{ stream: 'tab' as const, filename: 'tab.webm', error: 'x' }] };

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
    it('falls back to an idle snapshot for non-record input', () => {
      const snapshot = session.hydrate(null);
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.runConfig).toBeNull();
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
      expect(snapshot.runConfig).toEqual({ storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true });
      expect(snapshot.targetTabId).toBe(5);
      expect(snapshot.meetingSlug).toBe('abc-defg-hij');
      // Hydration becomes the live state.
      expect(session.getSnapshot().phase).toBe('recording');
    });
  });
});
