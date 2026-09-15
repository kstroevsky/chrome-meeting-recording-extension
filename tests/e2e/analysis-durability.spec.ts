/**
 * ADR-0007 / plan §11 item 5 — **analysis survives its control plane dying**.
 *
 * The claim under test is the one that justifies HOST-01…04 existing at all:
 * an analysis runs in the offscreen document, and killing the MV3 service
 * worker halfway through does not lose it. The job finishes, its terminal state
 * and its result are held until the background comes back, and the analysis is
 * readable afterwards.
 *
 * Every mechanical part of that is unit-tested against fakes. What only a
 * browser can prove is the part those fakes stand in for: real
 * `chrome.storage.local`, a real port reconnect, and a real service worker that
 * genuinely loses its memory.
 *
 * **Why the transcript is seeded rather than spoken.** Analysis has to still be
 * running when the worker is killed, which means enough windows to take
 * seconds — around a hundred, so around four hundred utterances. Driving that
 * many through the mock Meet caption region, each waiting out a grace window,
 * would take longer than the recording. `TRANSCRIPT_UTTERANCES` is the same
 * message the content script sends and takes a batch, so the test uses it
 * directly: the transcript arrives by the production path, just faster.
 *
 *   npm run build:e2e:mock && EXTENSION_PATH=dist-e2e npx playwright test analysis-durability
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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

test.setTimeout(300_000);

/** Enough windows that embedding takes seconds, at window 4 / stride 4. */
const UTTERANCES = 400;

type Manifest = {
  topics: Array<{ id: string; keywords: string[]; totalMs: number; spans: unknown[] }>;
};
type ManifestResponse = { ok: true; manifest: Manifest } | { ok: false; error: string };

/** The run's epoch and history id, which the popup-facing status view drops. */
async function runIdentity(controlPage: Page): Promise<{ epoch: number; historyId: string; startedAt: number }> {
  const identity = await controlPage.evaluate(async () => {
    const stored = await chrome.storage.session.get('recordingSession');
    const session = (stored as any)?.recordingSession;
    return { epoch: session?.epoch as number, historyId: session?.historyId as string, startedAt: session?.runningSince as number };
  });
  if (!identity.historyId || identity.epoch == null) throw new Error('No active recording session to seed against');
  return identity;
}

/**
 * Seeds committed caption utterances through the content script's own channel.
 * Wall-clock timestamps inside the run, because background projects them onto
 * the recorded timeline and refuses anything that overruns it.
 */
async function seedTranscript(controlPage: Page, epoch: number, startedAt: number, count: number): Promise<void> {
  await controlPage.evaluate(async ({ epoch, startedAt, count }) => {
    const subjects = [
      'the redis connection pool keeps saturating under load and the timeout we set is clearly far too aggressive for it',
      'flights to berlin are cheapest midweek and the hotel near the office had rooms left when i checked this morning',
      'the frontend candidate we interviewed yesterday answered the system design question better than anyone so far',
    ];
    const utterances = Array.from({ length: count }, (_, i) => {
      // Spread across the run so every projection lands inside the recorded span.
      const at = startedAt + Math.floor((i / count) * 1_500);
      return {
        startWallMs: at,
        endWallMs: at,
        speaker: i % 2 ? 'Ada' : 'Grace',
        text: `${subjects[Math.floor(i / 40) % subjects.length]} number ${i}`,
      };
    });
    await chrome.runtime.sendMessage({ type: 'TRANSCRIPT_UTTERANCES', runId: epoch, utterances });
  }, { epoch, startedAt, count });
}

async function manifestTopics(controlPage: Page, recordingId: string): Promise<Manifest['topics'] | null> {
  const response = await sendRuntimeMessage<ManifestResponse>(
    controlPage,
    { type: 'GET_RECORDING_PLAYBACK_MANIFEST', recordingId },
  );
  return response.ok ? response.manifest.topics : null;
}

test.describe('analysis durability (ADR-0007 HOST-01…04)', () => {
  test('completes and persists an analysis whose service worker is killed mid-run', async ({}, testInfo) => {
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

      const { epoch, historyId, startedAt } = await runIdentity(harness.controlPage);
      await harness.controlPage.waitForTimeout(2_000);
      await seedTranscript(harness.controlPage, epoch, startedAt, UTTERANCES);
      await harness.controlPage.waitForTimeout(500);
      await stopRecording(harness.controlPage);

      // Stopping finishes transcript capture and queues analysis. Give it long
      // enough to be genuinely in flight — loading the model alone is ~2 s.
      await harness.controlPage.waitForTimeout(4_000);

      // The guard that stops this test being vacuous: if the analysis already
      // finished, killing the worker afterwards proves nothing at all.
      const beforeKill = await manifestTopics(harness.controlPage, historyId).catch(() => null);
      expect(
        beforeKill?.length ?? 0,
        'the analysis finished before the service worker was killed — this run proved nothing about durability',
      ).toBe(0);

      // Kill the control plane. The offscreen document keeps the job.
      const session = await harness.context.newCDPSession(harness.controlPage);
      await session.send('ServiceWorker.enable' as never);
      await session.send('ServiceWorker.stopAllWorkers' as never);

      /*
       * Prove it actually died, by watching the target disappear.
       *
       * Not `context.on('serviceworker')`: Chrome reuses the *same* target id
       * when an extension's worker restarts, so that event never fires a second
       * time and a test waiting on it would pass having killed nothing. The
       * target list going empty is the observable that distinguishes a real
       * termination from a no-op — measured directly before trusting anything
       * this test goes on to assert.
       *
       * The window is short by design: the offscreen document's own port
       * reconnect is what wakes the worker again, and that is the path under
       * test.
       */
      let sawWorkerGone = false;
      for (let attempt = 0; attempt < 40 && !sawWorkerGone; attempt += 1) {
        const { targetInfos } = await session.send('Target.getTargets' as never) as {
          targetInfos: Array<{ type: string }>;
        };
        sawWorkerGone = !targetInfos.some((target) => target.type === 'service_worker');
        if (!sawWorkerGone) await harness.controlPage.waitForTimeout(50);
      }
      expect(sawWorkerGone, 'the service worker never went away — nothing was actually killed').toBe(true);

      // Every poll wakes the service worker again, which is the reconnect the
      // outbox replays into. The analysis must arrive without a second run.
      let topics: Manifest['topics'] | null = null;
      for (let attempt = 0; attempt < 60 && !topics?.length; attempt += 1) {
        await harness.controlPage.waitForTimeout(2_000);
        topics = await manifestTopics(harness.controlPage, historyId).catch(() => null);
      }

      expect(topics, 'the analysis never reached the manifest after the service worker was killed').toBeTruthy();
      expect(topics!.length).toBeGreaterThan(0);
      for (const topic of topics!) {
        expect(topic.spans.length).toBeGreaterThan(0);
        expect(topic.totalMs).toBeGreaterThanOrEqual(0);
      }

      // The outbox entry is released only on acknowledgement, so a persisted
      // analysis must leave no terminal job behind.
      const leftover = await harness.controlPage.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        return Object.keys(all).filter((key) => key.startsWith('analysisJobState:'));
      });
      expect(leftover, 'a terminal analysis job was never acknowledged').toEqual([]);

      await meetPage.close().catch(() => {});
    } finally {
      await closeHarness(harness);
    }
  });
});
