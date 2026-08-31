import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';
import { installDriveSimulator } from './helpers/driveSimulator';
import type { Page } from '@playwright/test';

type Notation = { id: string; tStartMs: number; tEndMs?: number; endedBy?: 'user' | 'auto'; text: string };
type HistoryEntry = { id: string; durationMs?: number };
type HistoryResponse = { ok: true; entries: HistoryEntry[] } | { ok: false; error: string };
type MarkResponse = { ok: true; notation: Notation } | { ok: false; error: string };
type ListResponse = { ok: true; notations: Notation[] } | { ok: false; error: string };

/** The run's history id, which the popup-facing status view deliberately drops. */
async function activeHistoryId(controlPage: Page): Promise<string> {
  const historyId = await controlPage.evaluate(async () => {
    const stored = await chrome.storage.session.get('recordingSession');
    return (stored as any)?.recordingSession?.historyId as string | undefined;
  });
  if (!historyId) throw new Error('No historyId on the active recording session');
  return historyId;
}

async function mark(controlPage: Page, text: string): Promise<Notation> {
  const response = await sendRuntimeMessage<MarkResponse>(controlPage, { type: 'MARK_NOTATION', text });
  if (!response.ok) throw new Error(`MARK_NOTATION failed: ${response.error}`);
  return response.notation;
}

test.describe('recording notations (integration)', () => {
  /**
   * The load-bearing guarantee of ADR-0005, proven against the real pipeline:
   * a notation timecode is an offset into the *produced media*, not wall clock.
   * Paused spans are never written to the file, so they must not advance the
   * mark clock either — otherwise every notation after a pause would seek to
   * the wrong place.
   */
  test('stamps marks on the recorded timeline, excluding paused spans', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const historyId = await activeHistoryId(harness.controlPage);

      await meetPage.waitForTimeout(2_000);
      const markA = await mark(harness.controlPage, 'before the pause');

      const paused = await sendRuntimeMessage<{ ok: boolean; error?: string }>(
        harness.controlPage,
        { type: 'SET_PAUSED', paused: true }
      );
      expect(paused.ok).toBe(true);

      // 3s of wall clock that the media never receives.
      await meetPage.waitForTimeout(3_000);
      await sendRuntimeMessage(harness.controlPage, { type: 'SET_PAUSED', paused: false });

      await meetPage.waitForTimeout(2_000);
      const markB = await mark(harness.controlPage, 'after the pause');

      await stopRecording(harness.controlPage);

      const listed = await sendRuntimeMessage<ListResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_NOTATIONS', recordingId: historyId }
      );
      if (!listed.ok) throw new Error(`LIST_RECORDING_NOTATIONS failed: ${listed.error}`);

      // Both marks survive the stop, in chronological order. Neither was ended
      // by hand, so the run sealed them on the way out.
      expect(listed.notations.map((notation) => notation.text))
        .toEqual(['before the pause', 'after the pause']);
      expect(listed.notations[0]).toMatchObject({ id: markA.id, tStartMs: markA.tStartMs, endedBy: 'auto' });
      expect(listed.notations[1]).toMatchObject({ id: markB.id, tStartMs: markB.tStartMs, endedBy: 'auto' });

      // ~2s of recording separates the marks even though ~5s of wall clock did.
      // The window is wide enough for CI timer noise but cannot admit 5s.
      const delta = markB.tStartMs - markA.tStartMs;
      expect(delta).toBeGreaterThanOrEqual(1_500);
      expect(delta).toBeLessThan(4_000);

      // The history row records the same pause-aware duration the marks are
      // measured against — ~4s of recording across a 7s wall-clock run. Marks
      // and duration sharing one domain is what lets a scrubber place them.
      const history = await sendRuntimeMessage<HistoryResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_HISTORY' }
      );
      if (!history.ok) throw new Error(`LIST_RECORDING_HISTORY failed: ${history.error}`);

      const entry = history.entries.find((candidate) => candidate.id === historyId);
      expect(entry, 'the finished recording should be in history').toBeDefined();
      expect(entry!.durationMs).toBeDefined();
      expect(entry!.durationMs).toBeGreaterThanOrEqual(markB.tStartMs);
      expect(entry!.durationMs).toBeLessThan(7_000);
    } finally {
      await closeHarness(harness);
    }
  });

  /**
   * The design's rule for a note the recording outlived: "closed at the last
   * saved frame and marked, rather than disappearing" (n4).
   */
  test('seals a note left open when the recording ends, rather than losing it', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const historyId = await activeHistoryId(harness.controlPage);

      await meetPage.waitForTimeout(1_500);
      const closed = await mark(harness.controlPage, 'user closes this one');
      await sendRuntimeMessage(harness.controlPage, { type: 'END_NOTATION', id: closed.id });

      await meetPage.waitForTimeout(1_000);
      const left = await mark(harness.controlPage, 'still open at stop');

      await stopRecording(harness.controlPage);

      const listed = await sendRuntimeMessage<ListResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_NOTATIONS', recordingId: historyId }
      );
      if (!listed.ok) throw new Error(`LIST_RECORDING_NOTATIONS failed: ${listed.error}`);
      expect(listed.notations).toHaveLength(2);

      const [first, second] = listed.notations;
      expect(first).toMatchObject({ id: closed.id, endedBy: 'user' });

      // The open one survived, sealed at the run's last recorded position and
      // marked as auto-closed so a screen can draw the dashed edge.
      expect(second.id).toBe(left.id);
      expect(second.endedBy).toBe('auto');
      expect(second.tEndMs).toBeGreaterThanOrEqual(left.tStartMs);

      const history = await sendRuntimeMessage<HistoryResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_HISTORY' }
      );
      if (!history.ok) throw new Error(`LIST_RECORDING_HISTORY failed: ${history.error}`);
      // Sealed at the recording's own end, never past it.
      const entry = history.entries.find((candidate) => candidate.id === historyId);
      expect(second.tEndMs!).toBeLessThanOrEqual(entry!.durationMs!);
    } finally {
      await closeHarness(harness);
    }
  });

  test('refuses to mark once the recording has stopped, and keeps earlier marks', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const historyId = await activeHistoryId(harness.controlPage);

      await meetPage.waitForTimeout(1_500);
      const marked = await mark(harness.controlPage, 'during');
      await stopRecording(harness.controlPage);

      const late = await sendRuntimeMessage<MarkResponse>(
        harness.controlPage,
        { type: 'MARK_NOTATION', text: 'too late' }
      );
      expect(late).toEqual({ ok: false, error: 'Mark requested but no recording is active' });

      const listed = await sendRuntimeMessage<ListResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_NOTATIONS', recordingId: historyId }
      );
      if (!listed.ok) throw new Error(`LIST_RECORDING_NOTATIONS failed: ${listed.error}`);
      expect(listed.notations).toMatchObject([{ id: marked.id, tStartMs: marked.tStartMs, endedBy: 'auto' }]);
    } finally {
      await closeHarness(harness);
    }
  });

  /**
   * The Drive path creates its history row from `applyUploadJob` rather than the
   * local save handler, and does so after the session may already have returned
   * to idle — a different code path with a different race than the local one.
   */
  test('records marks and duration on a Drive recording too', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await installDriveSimulator(harness.context, 'fast');
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'drive',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const historyId = await activeHistoryId(harness.controlPage);

      await meetPage.waitForTimeout(2_000);
      const marked = await mark(harness.controlPage, 'drive mark');
      await stopRecording(harness.controlPage);

      await expect.poll(async () => {
        const history = await sendRuntimeMessage<HistoryResponse>(
          harness.controlPage,
          { type: 'LIST_RECORDING_HISTORY' }
        );
        return history.ok ? history.entries.find((e) => e.id === historyId)?.durationMs : undefined;
      }, { timeout: 45_000 }).toBeGreaterThanOrEqual(marked.tStartMs);

      const listed = await sendRuntimeMessage<ListResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_NOTATIONS', recordingId: historyId }
      );
      if (!listed.ok) throw new Error(`LIST_RECORDING_NOTATIONS failed: ${listed.error}`);
      expect(listed.notations).toMatchObject([{ id: marked.id, tStartMs: marked.tStartMs, endedBy: 'auto' }]);
    } finally {
      await closeHarness(harness);
    }
  });

  test('drops the run’s marks when the recording is discarded', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const historyId = await activeHistoryId(harness.controlPage);

      await meetPage.waitForTimeout(1_500);
      await mark(harness.controlPage, 'will be discarded');

      const discarded = await sendRuntimeMessage<{ ok: boolean; error?: string }>(
        harness.controlPage,
        { type: 'DISCARD_RECORDING' }
      );
      expect(discarded.ok).toBe(true);

      const listed = await sendRuntimeMessage<ListResponse>(
        harness.controlPage,
        { type: 'LIST_RECORDING_NOTATIONS', recordingId: historyId }
      );
      if (!listed.ok) throw new Error(`LIST_RECORDING_NOTATIONS failed: ${listed.error}`);
      expect(listed.notations).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });
});
