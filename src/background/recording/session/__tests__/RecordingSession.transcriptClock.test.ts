import { RecordingSession } from '../RecordingSession';
import type { RecordingRunConfig } from '../../../../shared/recording';

const RUN_CONFIG: RecordingRunConfig = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

describe('RecordingSession transcript clock', () => {
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
    describe('recordedMsAt (the transcript time base, ADR-0007)', () => {
      it('projects a past instant inside the running span onto the media timeline', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenAt = t + 3000;

        t += 9000;
        // A caption committed 6s ago still maps to where it belongs in the file,
        // not to where the clock is now.
        expect(session.recordedMsAt(spokenAt)).toBe(3000);
        expect(session.currentRecordedMs()).toBe(9000);
      });

      it('agrees with currentRecordedMs for the present instant', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        t += 4200;
        expect(session.recordedMsAt(t)).toBe(session.currentRecordedMs());
      });

      it('refuses an instant from before the run started', () => {
        const beforeStart = t - 1;
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        expect(session.recordedMsAt(beforeStart)).toBeUndefined();
      });

      it('refuses everything while paused, because a paused span is not in the media', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 3000;
        session.setPaused(true);

        t += 5000;
        // Clamping these to the pause position would seek to words that are not
        // in the file.
        expect(session.recordedMsAt(t)).toBeUndefined();
        expect(session.recordedMsAt(t - 1000)).toBeUndefined();
      });

      it('resumes projecting after a pause, excluding the paused span', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 5000;
        session.setPaused(true);
        t += 10000;
        session.setPaused(false);

        t += 2000;
        expect(session.recordedMsAt(t)).toBe(7000);
      });

      it('refuses before any run has happened', () => {
        expect(session.recordedMsAt(t)).toBeUndefined();
      });

      it('still projects after the run has ended — the transcript sweep runs then', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenAt = t + 6_800;

        t += 7000;
        session.applyOffscreenPhase({ phase: 'stopping' });
        session.markIdle();

        // The words were spoken 200ms before the recorder stopped, and they are
        // in the file. Before the span ledger this answered `undefined`, so the
        // end-of-run sweep silently stored nothing.
        expect(session.recordedMsAt(spokenAt)).toBe(6_800);
      });

      it('refuses an instant after the run ended', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 7000;
        session.markIdle();

        const afterStop = t + 5_000;
        t = afterStop;
        expect(session.recordedMsAt(afterStop)).toBeUndefined();
      });

      it('still projects a pre-pause instant after the run ends, excluding the pause', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const earlyWord = t + 2_000;

        t += 5_000;
        session.setPaused(true);
        t += 10_000;
        session.setPaused(false);
        const lateWord = t + 1_000;

        t += 3_000;
        session.markIdle();

        // Both map, and the 10s pause between them is absent from both offsets.
        expect(session.recordedMsAt(earlyWord)).toBe(2_000);
        expect(session.recordedMsAt(lateWord)).toBe(6_000);
      });

      it('starts a new run on a clean ledger', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const firstRunWord = t + 1_000;
        t += 4_000;
        session.markIdle();

        t += 60_000;
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        // The previous run's timeline is not this run's.
        expect(session.recordedMsAt(firstRunWord)).toBeUndefined();
      });

      it('refuses a non-finite instant', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });

        expect(session.recordedMsAt(Number.NaN)).toBeUndefined();
        expect(session.recordedMsAt(Infinity)).toBeUndefined();
      });
    });

    describe('recordedRangeAt (an utterance\'s span, ADR-0007)', () => {
      it('projects a whole utterance that fits inside one recorded span', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 2_000;
        const spokenTo = t + 3_500;

        t += 9_000;
        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toEqual({ tStartMs: 2_000, tEndMs: 3_500 });
      });

      it('places an utterance that stopped changing before the cutoff, whenever it commits', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 9_700;
        const spokenTo = t + 9_900; // last text change, before the recorder stopped

        t += 10_000;
        session.markIdle();
        // The caption commits 2.2s later, but commit time is not part of the
        // range — the words are in the file and map whole.
        t += 2_200;

        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toEqual({ tStartMs: 9_700, tEndMs: 9_900 });
      });

      it('refuses an utterance whose text was still changing after the recorder stopped', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 9_700;

        t += 10_000;
        session.markIdle();
        // Meet kept refining the same caption after the cutoff, so its final
        // text contains words the recording does not. Truncating the timestamp
        // would leave those words anchored to media that never held them.
        const spokenTo = t + 1_500;

        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toBeUndefined();
      });

      it('refuses an utterance still changing after a pause, before any resume', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 4_500;

        t += 5_000;
        session.setPaused(true);
        const spokenTo = t + 2_000; // still talking, but nothing is being recorded

        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toBeUndefined();
      });

      it('refuses an utterance that straddles a pause once recording resumed', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 9_000;

        t += 10_000;
        session.setPaused(true);
        t += 3_000;
        session.setPaused(false);
        const spokenTo = t + 1_000;

        // Some of these words are in span 0 and some in span 1, and without
        // word-level timing there is no way to say where the text divides.
        // Truncating would attribute post-resume speech to pre-pause media.
        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toBeUndefined();
        // Its start alone still maps — only the range is unresolvable.
        expect(session.recordedMsAt(spokenFrom)).toBe(9_000);
      });

      it('still places an utterance that ends inside its own span after a later pause', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenFrom = t + 2_000;
        const spokenTo = t + 2_800;

        t += 10_000;
        session.setPaused(true);
        t += 3_000;
        session.setPaused(false);
        t += 5_000;

        expect(session.recordedRangeAt(spokenFrom, spokenTo)).toEqual({ tStartMs: 2_000, tEndMs: 2_800 });
      });

      it('refuses an utterance that began inside a pause', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        t += 3_000;
        session.setPaused(true);

        const spokenFrom = t + 1_000;
        t += 5_000;
        session.setPaused(false);

        expect(session.recordedRangeAt(spokenFrom, spokenFrom + 500)).toBeUndefined();
      });

      it('never returns an end before its start', () => {
        session.start(RUN_CONFIG, { targetTabId: 42 });
        session.applyOffscreenPhase({ phase: 'recording' });
        const spokenAt = t + 2_000;

        t += 5_000;
        const range = session.recordedRangeAt(spokenAt, spokenAt - 1_000);
        expect(range).toEqual({ tStartMs: 2_000, tEndMs: 2_000 });
      });
    });

  });
});
