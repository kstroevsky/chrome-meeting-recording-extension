import { RecordingSession } from '../RecordingSession';
import type { RecordingRunConfig } from '../../../../shared/recording';

const RUN_CONFIG: RecordingRunConfig = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

describe('RecordingSession clock', () => {
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
    it('counts pause-aware recorded time across start, pause, resume, and stop', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });

      const rec = session.applyOffscreenPhase({ phase: 'recording' });
      expect(rec.recordedMs).toBe(0);
      expect(rec.runningSince).toBe(t);

      t += 5000; // record 5s, then pause → bank 5s and stop the clock
      const paused = session.setPaused(true);
      expect(paused.recordedMs).toBe(5000);
      expect(paused.runningSince).toBeUndefined();

      t += 10000; // 10s paused — must NOT accrue
      const resumed = session.setPaused(false);
      expect(resumed.recordedMs).toBe(5000);
      expect(resumed.runningSince).toBe(t);

      t += 3000; // 3s more, then stop → frozen at 8s for the uploading view
      const stopping = session.markStopping();
      expect(stopping.recordedMs).toBe(8000);
      expect(stopping.runningSince).toBeUndefined();
    });

    it('keeps the timer running across a recording re-broadcast', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      const since = t;

      t += 2000;
      const rebroadcast = session.applyOffscreenPhase({ phase: 'recording', warnings: ['w'] });
      expect(rebroadcast.runningSince).toBe(since);
      expect(rebroadcast.recordedMs).toBe(0);
    });

    it('clears the timer when the session returns to idle', () => {
      session.start(RUN_CONFIG, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });

      const idle = session.markIdle();
      expect(idle.recordedMs).toBeUndefined();
      expect(idle.runningSince).toBeUndefined();
    });

    describe('currentRecordedMs (the notation time base, ADR-0005)', () => {
      it('reads the live position mid-span, ahead of the banked recordedMs', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 4200;
        expect(session.getSnapshot().recordedMs).toBe(0); // only banked at transitions
        expect(session.currentRecordedMs()).toBe(4200);
      });

      it('excludes paused spans, so a mark maps onto the media offset', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 5000;
        const markA = session.currentRecordedMs();

        session.setPaused(true);
        t += 10000; // 10s of wall clock that is never written into the media
        session.setPaused(false);

        t += 5000;
        const markB = session.currentRecordedMs();

        // The gap between the marks is recorded time only — 5s, not the 15s of
        // wall clock that elapsed between them.
        expect(markA).toBe(5000);
        expect(markB).toBe(10000);
        expect(markB - markA).toBe(5000);
      });

      it('does not advance while paused', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 3000;
        session.setPaused(true);
        const atPause = session.currentRecordedMs();

        t += 8000;
        expect(session.currentRecordedMs()).toBe(atPause);
      });

      it('accepts an explicit clock reading', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        expect(session.currentRecordedMs(t + 1500)).toBe(1500);
      });

      it('reports 0 while idle, so a mark can never be stamped off a dead clock', () => {
        expect(session.currentRecordedMs()).toBe(0);

        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 7000;
        session.markIdle();

        expect(session.currentRecordedMs()).toBe(0);
      });
    });

  });
});
