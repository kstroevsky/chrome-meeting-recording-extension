import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openDebugDashboard,
  openMockMeetPage,
  readPerfSnapshot,
  saveRecordingSettings,
  setPerfSettings,
  startRecording,
  stopRecording,
  waitForPerfSnapshot,
} from './helpers/extensionHarness';

/**
 * Measures main-thread contention from the OPFS storage backend, in BOTH phases:
 *
 *  - recording phase: chunk writes (worker = off-thread, main-thread = writable).
 *  - finalize phase:  the WebM duration fix parse (worker/bonus = off-thread,
 *                     fallback = webm-duration-fix on the main thread).
 *
 * Runs the SAME heavy workload twice (opfsWorkerStorage on/off) and compares the
 * runtime sampler's main-thread metrics. longTaskCount (PerformanceObserver) is
 * the reliable signal — it catches every >50ms block regardless of the sampler
 * interval, and the finalize delta isolates the finalize-phase cost.
 *
 * The recorded numbers are the deliverable (attached + logged); assertions are
 * only loose non-regression guards.
 */

type PhaseMetrics = {
  longTaskCount: number;
  maxLongTaskMs: number | null;
  maxEventLoopLagMs: number | null;
  avgEventLoopLagMs: number | null;
  sampleCount: number;
};

type Contention = {
  backend: 'worker' | 'main-thread';
  totalWrites: number;
  workerWrites: number;
  peakPendingWrites: number;
  recording: PhaseMetrics;
  // Finalize-phase cost, isolated as (post-finalize cumulative) − (during recording).
  finalizeLongTasks: number;
  finalizeMaxLongTaskMs: number | null;
  finalizeMaxEventLoopLagMs: number | null;
};

// Heavy + write-frequent + long enough that the finalize duration-fix parse is
// non-trivial: 1080p tab + 720p camera + mic, a chunk every 500ms, ~20s.
const RECORD_MS = 20_000;
const recordingSettings = {
  recordingMode: 'opfs' as const,
  micMode: 'separate' as const,
  recordSelfVideo: true,
  tabResolution: '1920x1080' as const,
  tabFrameRate: 30,
  selfVideoResolution: '1280x720' as const,
  selfVideoFrameRate: 30,
  chunkDefaultTimesliceMs: 500,
  chunkExtendedTimesliceMs: 500,
};

test.describe('OPFS storage main-thread contention', () => {
  test('@perf-contention worker storage vs main-thread writable (record + finalize)', async ({}, testInfo) => {
    test.setTimeout(300_000);

    async function measure(useWorker: boolean): Promise<Contention> {
      const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
      try {
        // Hold a debug dashboard open so the diagnostics snapshot is NOT cleared
        // on idle — otherwise the post-finalize read races (and loses) the clear.
        // The dashboard runs in its own page, so it does not contend with the
        // offscreen main thread the runtime sampler measures.
        await openDebugDashboard(harness);
        await setPerfSettings(harness.controlPage, { opfsWorkerStorage: useWorker });
        await saveRecordingSettings(harness.controlPage, recordingSettings);
        const meetPage = await openMockMeetPage(harness.context);
        const meetTabId = await findMockMeetTabId(harness.controlPage);

        await startRecording(harness.controlPage, meetTabId, {
          storageMode: 'local',
          micMode: 'separate',
          recordSelfVideo: true,
        });
        await waitForPerfSnapshot(
          harness.controlPage,
          (s) => (s.summary.recorder.startCountByStream.tab ?? 0) > 0,
          30_000
        );

        await meetPage.waitForTimeout(RECORD_MS);
        // Recording-phase snapshot (read while still recording; reset around idle).
        const during = await readPerfSnapshot(harness.controlPage);

        // stopRecording waits for the session to reach idle (all streams sealed +
        // finalized). The dashboard keeps the snapshot alive, so this read holds
        // the full recording + finalize metrics.
        await stopRecording(harness.controlPage);
        const after = await waitForPerfSnapshot(
          harness.controlPage,
          (s) =>
            s.summary.lifecycle.stopCompletedCount > 0
            && Object.keys(s.summary.finalization.fileCountByStream).length >= 3,
          30_000
        );

        const dr = during?.summary.runtime;
        const ar = after.summary.runtime;
        const storage = after.summary.storage;
        return {
          backend: useWorker ? 'worker' : 'main-thread',
          totalWrites: storage.writeCount,
          workerWrites: storage.workerWriteCount,
          peakPendingWrites: storage.peakPendingWrites,
          recording: {
            longTaskCount: dr?.longTaskCount ?? 0,
            maxLongTaskMs: dr?.maxLongTaskMs ?? null,
            maxEventLoopLagMs: dr?.maxEventLoopLagMs ?? null,
            avgEventLoopLagMs: dr?.avgEventLoopLagMs ?? null,
            sampleCount: dr?.sampleCount ?? 0,
          },
          finalizeLongTasks: (ar.longTaskCount ?? 0) - (dr?.longTaskCount ?? 0),
          finalizeMaxLongTaskMs: ar.maxLongTaskMs ?? null,
          finalizeMaxEventLoopLagMs: ar.maxEventLoopLagMs ?? null,
        };
      } finally {
        await closeHarness(harness);
      }
    }

    const worker = await measure(true);
    const mainThread = await measure(false);

    // The A/B switch actually flipped the storage backend.
    expect(worker.workerWrites).toBe(worker.totalWrites);
    expect(worker.totalWrites).toBeGreaterThan(0);
    expect(mainThread.workerWrites).toBe(0);
    expect(mainThread.totalWrites).toBeGreaterThan(0);

    const comparison = { worker, mainThread, finalizeLongTaskDelta: worker.finalizeLongTasks - mainThread.finalizeLongTasks };
    // eslint-disable-next-line no-console
    console.log('[storage-contention]', JSON.stringify(comparison, null, 2));
    await testInfo.attach('storage-contention.json', {
      body: JSON.stringify(comparison, null, 2),
      contentType: 'application/json',
    });

    // Loose non-regression guards (the reported numbers are the real deliverable).
    if (worker.recording.avgEventLoopLagMs != null && mainThread.recording.avgEventLoopLagMs != null) {
      expect(worker.recording.avgEventLoopLagMs).toBeLessThanOrEqual(mainThread.recording.avgEventLoopLagMs * 2 + 30);
    }
    // The worker runs the duration fix off-thread, so it must not add MORE finalize
    // long tasks than the main-thread parse.
    expect(worker.finalizeLongTasks).toBeLessThanOrEqual(mainThread.finalizeLongTasks + 1);
  });
});
