import { RecordingTranscriptCapture } from '../RecordingTranscriptCapture';
import { RecordingTranscriptService } from '../RecordingTranscriptService';
import type { RecordingTranscriptMutation, RecordingTranscriptRepositoryPort } from '../RecordingTranscriptRepository';
import { normalizeTranscript, type CaptionUtterance, type Transcript } from '../../shared/transcript';
import { RecordingSession } from '../RecordingSession';
import type { RecordingRunConfig } from '../../shared/recording';

function fakeRepository() {
  const rows = new Map<string, Transcript>();
  const port: RecordingTranscriptRepositoryPort & { rows: Map<string, Transcript> } = {
    rows,
    async get(recordingId) { return rows.get(recordingId); },
    async update(recordingId: string, mutate: RecordingTranscriptMutation) {
      const next = normalizeTranscript(mutate(rows.get(recordingId)));
      if (next && next.segments.length) rows.set(recordingId, next);
      else rows.delete(recordingId);
      return next;
    },
    async remove(recordingId) { rows.delete(recordingId); },
  };
  return port;
}

const RUN_START = 1_000_000;
const RUN_END = RUN_START + 30_000;
const RUN_ID = 7;

const utterance = (offsetMs: number, text: string): CaptionUtterance =>
  ({ startWallMs: RUN_START + offsetMs, endWallMs: RUN_START + offsetMs + 400, speaker: 'Ada', text });

function harness(over: Partial<{ historyId?: string; runId?: number }> = {}) {
  const repository = fakeRepository();
  const transcripts = new RecordingTranscriptService(repository);
  const sendToTab = jest.fn(
    async (_tabId: number, _message: unknown) => ({ utterances: [] as CaptionUtterance[] }),
  );
  const warn = jest.fn();
  const capture = new RecordingTranscriptCapture({
    transcripts,
    activeHistoryId: () => ('historyId' in over ? over.historyId : 'rec:1'),
    activeRunId: () => ('runId' in over ? over.runId : RUN_ID),
    // One recorded span, closed — the shape the ledger holds after a run ends.
    // Mirrors `RecordingSession.recordedRangeAt` exactly, refusals included: a
    // stub that is more permissive than the real rule hides the bugs it should
    // be catching.
    recordedRangeAt: (startWallMs, endWallMs) => {
      if (startWallMs < RUN_START || startWallMs > RUN_END) return undefined;
      if (endWallMs > RUN_END) return undefined;
      const end = Math.max(endWallMs, startWallMs);
      return { tStartMs: startWallMs - RUN_START, tEndMs: end - RUN_START };
    },
    sendToTab,
    warn,
  });
  return { capture, repository, transcripts, sendToTab, warn };
}

describe('RecordingTranscriptCapture', () => {
  it('arms the meeting tab with the run it belongs to, and disarms at the end', async () => {
    const { capture, sendToTab } = harness();
    await capture.arm(42, RUN_ID);
    expect(sendToTab).toHaveBeenCalledWith(42, { type: 'SET_TRANSCRIPT_CAPTURE', active: true, runId: RUN_ID });

    await capture.finish('rec:1');
    expect(sendToTab).toHaveBeenLastCalledWith(42, { type: 'SET_TRANSCRIPT_CAPTURE', active: false });
  });

  it('stores pushed utterances against the active run, on the media timeline', async () => {
    const { capture, repository } = harness();
    await capture.receive(RUN_ID, [utterance(3_000, 'the pool is saturated')]);

    expect(repository.rows.get('rec:1')).toEqual({
      source: 'meet-captions',
      segments: [{ tStartMs: 3_000, tEndMs: 3_400, speaker: 'Ada', text: 'the pool is saturated' }],
    });
  });

  it('drops a push from a previous run that arrived after the next one started', async () => {
    const { capture, repository } = harness();
    await capture.receive(RUN_ID - 1, [utterance(3_000, 'last run\'s words')]);
    expect(repository.rows.size).toBe(0);

    await capture.receive(RUN_ID, [utterance(3_000, 'this run\'s words')]);
    expect(repository.rows.get('rec:1')?.segments.map((s) => s.text)).toEqual(["this run's words"]);
  });

  it('drops words spoken when nothing is recording — a transcript is keyed to a run', async () => {
    const { capture, repository } = harness({ historyId: undefined });
    await capture.receive(RUN_ID, [utterance(3_000, 'idle chatter')]);
    expect(repository.rows.size).toBe(0);
  });

  it('drops words that fall outside the recorded media rather than clamping them', async () => {
    const { capture, repository } = harness();
    await capture.receive(RUN_ID, [
      { startWallMs: RUN_START - 5_000, endWallMs: RUN_START - 4_000, speaker: 'Ada', text: 'before the run' },
      utterance(1_000, 'during the run'),
    ]);

    expect(repository.rows.get('rec:1')?.segments.map((s) => s.text)).toEqual(['during the run']);
  });

  it('keeps words spoken just before the stop but committed just after it', async () => {
    // The regression this whole ledger exists for: the sweep runs once the run
    // is over, so a projection that only worked mid-run stored nothing at all.
    const { capture, repository, sendToTab } = harness();
    await capture.arm(42, RUN_ID);
    sendToTab.mockResolvedValue({
      utterances: [{
        startWallMs: RUN_END - 300,
        endWallMs: RUN_END - 100, // stopped changing before the cutoff
        speaker: 'Ada',
        text: "that's the answer",
      }],
    });

    await capture.finish('rec:1');

    expect(repository.rows.get('rec:1')?.segments).toEqual([
      { tStartMs: 29_700, tEndMs: 29_900, speaker: 'Ada', text: "that's the answer" },
    ]);
  });

  it('refuses a caption Meet kept refining after the recorder stopped', async () => {
    const { capture, repository, sendToTab, warn } = harness();
    await capture.arm(42, RUN_ID);
    sendToTab.mockResolvedValue({
      utterances: [{
        startWallMs: RUN_END - 300,
        endWallMs: RUN_END + 1_200,
        speaker: 'Ada',
        // The trailing clause was spoken after the cutoff and is in no media.
        text: "that's the answer and actually...",
      }],
    });

    await capture.finish('rec:1');

    expect(repository.rows.get('rec:1')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Dropped 1 caption utterance(s) with no media position');
  });

  it('drains the tab at a pause boundary without disarming it', async () => {
    const { capture, repository, sendToTab } = harness();
    await capture.arm(42, RUN_ID);
    sendToTab.mockResolvedValue({ utterances: [utterance(2_000, 'before the pause')] });

    await capture.flushAtBoundary('rec:1');

    expect(repository.rows.get('rec:1')?.segments.map((s) => s.text)).toEqual(['before the pause']);
    // Still armed: the run is paused, not over.
    expect(sendToTab).not.toHaveBeenCalledWith(42, expect.objectContaining({ active: false }));
  });

  it('does nothing at a pause boundary when no tab was armed', async () => {
    const { capture, sendToTab } = harness();
    await capture.flushAtBoundary('rec:1');
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('reports utterances it could not place, rather than losing them silently', async () => {
    const { capture, warn } = harness();
    await capture.receive(RUN_ID, [
      { startWallMs: RUN_START - 9_000, endWallMs: RUN_START - 8_000, speaker: 'Ada', text: 'before the run' },
      utterance(1_000, 'inside the run'),
    ]);

    expect(warn).toHaveBeenCalledWith('Dropped 1 caption utterance(s) with no media position');
  });

  it('tells a freshly loaded content script whether it should be shipping', () => {
    expect(harness().capture.captureState()).toEqual({ active: true, runId: RUN_ID });
    expect(harness({ historyId: undefined }).capture.captureState()).toEqual({ active: false });
    expect(harness({ runId: undefined }).capture.captureState()).toEqual({ active: false });
  });

  it('sweeps the tab at the end of a run and keeps what the push missed', async () => {
    const { capture, repository, sendToTab } = harness();
    await capture.arm(42, RUN_ID);
    await capture.receive(RUN_ID, [utterance(1_000, 'pushed')]);
    sendToTab.mockImplementation(async (_tabId: number, message: unknown) => (
      (message as { type: string }).type === 'GET_TRANSCRIPT_UTTERANCES'
        ? { utterances: [utterance(1_000, 'pushed'), utterance(6_000, 'never pushed')] }
        : { utterances: [] }
    ));

    await capture.finish('rec:1');

    // The redelivered utterance is dropped; the one the push never carried is kept.
    expect(repository.rows.get('rec:1')?.segments.map((s) => s.text)).toEqual(['pushed', 'never pushed']);
  });

  it('sweeps against the finished run id, not whatever the session moved on to', async () => {
    const { capture, repository, sendToTab } = harness({ historyId: undefined });
    await capture.arm(42, RUN_ID);
    sendToTab.mockResolvedValue({ utterances: [utterance(2_000, 'last words')] });

    await capture.finish('rec:finished');
    expect(repository.rows.get('rec:finished')?.segments.map((s) => s.text)).toEqual(['last words']);
  });

  it('survives a closed meeting tab at the end of a run', async () => {
    const { capture, sendToTab, warn } = harness();
    await capture.arm(42, RUN_ID);
    sendToTab.mockRejectedValue(new Error('Receiving end does not exist'));

    await expect(capture.finish('rec:1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // The sweep and the disarm, both against a dead tab, both harmless.
    expect(sendToTab).toHaveBeenCalledTimes(3);
  });

  it('does nothing at the end of a run that was never armed', async () => {
    // A non-Meet capture: no content script, so nothing was ever armed.
    const { capture, sendToTab } = harness();
    await capture.finish('rec:1');
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('forgets the armed tab after a run, so a later sweep cannot reach it', async () => {
    const { capture, sendToTab } = harness();
    await capture.arm(42, RUN_ID);
    await capture.finish('rec:1');
    sendToTab.mockClear();

    await capture.finish('rec:1');
    expect(sendToTab).not.toHaveBeenCalled();
  });

  it('swallows a storage failure rather than disturbing the run', async () => {
    const { capture, transcripts, warn } = harness();
    jest.spyOn(transcripts, 'append').mockRejectedValue(new Error('IndexedDB is unavailable'));

    await expect(capture.receive(RUN_ID, [utterance(1_000, 'words')])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Could not append to the recording transcript:', expect.any(Error));
  });

  it('does not touch storage for an empty push', async () => {
    const { capture, transcripts } = harness();
    const append = jest.spyOn(transcripts, 'append');
    await capture.receive(RUN_ID, []);
    expect(append).not.toHaveBeenCalled();
  });
});

/**
 * Against the real clock rather than a stub.
 *
 * The stubbed projector above cannot express a torn-down clock, and that is
 * exactly what hid the original defect: projection worked mid-run and silently
 * answered nothing once the run ended, so the end-of-run sweep stored zero
 * segments. These tests drive `RecordingSession` itself.
 */
describe('RecordingTranscriptCapture against a real RecordingSession', () => {
  const RUN_CONFIG: RecordingRunConfig = { storageMode: 'local', micMode: 'off', recordSelfVideo: false };
  let t = 5_000_000;
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    t = 5_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => t);
  });
  afterEach(() => nowSpy.mockRestore());

  function realHarness() {
    const repository = fakeRepository();
    const transcripts = new RecordingTranscriptService(repository);
    const session = new RecordingSession(jest.fn(), jest.fn());
    const swept: CaptionUtterance[] = [];
    const sendToTab = jest.fn(
      async (_tabId: number, message: unknown) => (
        (message as { type: string }).type === 'GET_TRANSCRIPT_UTTERANCES'
          ? { utterances: swept }
          : { utterances: [] as CaptionUtterance[] }
      ),
    );
    const capture = new RecordingTranscriptCapture({
      transcripts,
      activeHistoryId: () => session.getSnapshot().historyId,
      activeRunId: () => session.getSnapshot().epoch,
      recordedRangeAt: (a, b) => session.recordedRangeAt(a, b),
      sendToTab,
      warn: jest.fn(),
    });
    return { capture, repository, session, swept };
  }

  it('stores the last words of a run, swept after the session went idle', async () => {
    const { capture, repository, session, swept } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const historyId = session.getSnapshot().historyId!;
    await capture.arm(42, session.getSnapshot().epoch!);

    const spokenAt = t + 9_700;
    t += 10_000;
    session.applyOffscreenPhase({ phase: 'stopping' });
    session.markIdle();

    // Committed after the recorder stopped, which is the normal case for the
    // final utterance of a call.
    t += 2_200;
    swept.push({ startWallMs: spokenAt, endWallMs: spokenAt + 300, speaker: 'Ada', text: "that's the answer" });

    await capture.finish(historyId);

    expect(repository.rows.get(historyId)?.segments).toEqual([
      { tStartMs: 9_700, tEndMs: 10_000, speaker: 'Ada', text: "that's the answer" },
    ]);
  });

  it('excludes a paused stretch from the offsets it stores', async () => {
    const { capture, repository, session } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const historyId = session.getSnapshot().historyId!;
    const runId = session.getSnapshot().epoch!;

    const early = t + 2_000;
    t += 5_000;
    session.setPaused(true);
    t += 10_000;
    session.setPaused(false);
    const late = t + 1_000;
    t += 3_000;

    await capture.receive(runId, [
      { startWallMs: early, endWallMs: early + 200, speaker: 'Ada', text: 'before the pause' },
      { startWallMs: late, endWallMs: late + 200, speaker: 'Ada', text: 'after the pause' },
    ]);

    // 10s of wall clock separates the pause, but only 4s of media does.
    expect(repository.rows.get(historyId)?.segments.map((s) => s.tStartMs)).toEqual([2_000, 6_000]);
  });

  it('refuses a caption that straddles a pause rather than mis-attributing its words', async () => {
    const { capture, repository, session } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const historyId = session.getSnapshot().historyId!;
    const runId = session.getSnapshot().epoch!;

    // "we should deploy it tomorrow morning" — begun before the pause, still
    // being refined after the resume, with no word-level timing to divide it.
    const spokenFrom = t + 9_000;
    t += 10_000;
    session.setPaused(true);
    t += 3_000;
    session.setPaused(false);
    const spokenTo = t + 1_000;
    t += 2_000;

    await capture.receive(runId, [
      { startWallMs: spokenFrom, endWallMs: spokenTo, speaker: 'Ada', text: 'we should deploy it tomorrow morning' },
    ]);

    expect(repository.rows.get(historyId)).toBeUndefined();
  });

  it('keeps both halves when the buffer is flushed at the pause boundary', async () => {
    const { capture, repository, session, swept } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const historyId = session.getSnapshot().historyId!;
    const runId = session.getSnapshot().epoch!;
    await capture.arm(42, runId);

    const beforeStart = t + 9_000;
    t += 10_000;
    // The flush commits what is open, so this utterance ends at the boundary.
    swept.push({ startWallMs: beforeStart, endWallMs: t, speaker: 'Ada', text: 'we should deploy it' });
    await capture.flushAtBoundary(historyId);
    session.setPaused(true);

    t += 3_000;
    session.setPaused(false);
    const afterStart = t + 500;
    t += 2_000;
    await capture.receive(runId, [
      { startWallMs: afterStart, endWallMs: afterStart + 400, speaker: 'Ada', text: 'tomorrow morning' },
    ]);

    // Both land, each inside media that exists, and the 3s pause is absent.
    expect(repository.rows.get(historyId)?.segments).toEqual([
      { tStartMs: 9_000, tEndMs: 10_000, speaker: 'Ada', text: 'we should deploy it' },
      { tStartMs: 10_500, tEndMs: 10_900, speaker: 'Ada', text: 'tomorrow morning' },
    ]);
  });

  it('keeps the drained caption and refuses the refinement Meet makes after the stop', async () => {
    const { capture, repository, session, swept } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const historyId = session.getSnapshot().historyId!;
    await capture.arm(42, session.getSnapshot().epoch!);

    const spokenFrom = t + 9_000;
    t += 10_000;
    // The drain at the cutoff sees the caption as it stands: text so far, last
    // change before the recorder stopped.
    swept.push({ startWallMs: spokenFrom, endWallMs: t - 100, speaker: 'Ada', text: "that's the answer" });
    session.markStopping();
    await capture.flushAtBoundary(historyId);

    // Meet carries on refining the same caption after the cutoff.
    t += 2_000;
    swept.length = 0;
    swept.push({
      startWallMs: spokenFrom,
      endWallMs: t,
      speaker: 'Ada',
      text: "that's the answer and actually...",
    });
    session.markIdle();
    await capture.finish(historyId);

    // The drained version survives; the refinement, whose trailing words are in
    // no media, is refused rather than truncated onto the recorded span.
    expect(repository.rows.get(historyId)?.segments).toEqual([
      { tStartMs: 9_000, tEndMs: 9_900, speaker: 'Ada', text: "that's the answer" },
    ]);
  });

  it('refuses to file the previous run\'s words under the next run', async () => {
    const { capture, repository, session } = realHarness();
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const firstRunId = session.getSnapshot().epoch!;
    const spokenInFirstRun = t + 1_000;

    t += 4_000;
    session.markIdle();
    t += 60_000;
    session.start(RUN_CONFIG, { targetTabId: 42 });
    session.applyOffscreenPhase({ phase: 'recording' });
    const secondHistoryId = session.getSnapshot().historyId!;

    // A push from the first run, delayed across the boundary.
    await capture.receive(firstRunId, [
      { startWallMs: spokenInFirstRun, endWallMs: spokenInFirstRun + 200, speaker: 'Ada', text: 'stale' },
    ]);

    expect(repository.rows.get(secondHistoryId)).toBeUndefined();
  });
});
