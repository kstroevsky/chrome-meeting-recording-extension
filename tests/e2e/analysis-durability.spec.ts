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

/** Stops every service worker, via CDP. */
async function killServiceWorker(session: import('@playwright/test').CDPSession): Promise<void> {
  await session.send('ServiceWorker.stopAllWorkers' as never);
}

/** Whether any extension service worker is currently running. */
async function workerAlive(session: import('@playwright/test').CDPSession): Promise<boolean> {
  const { targetInfos } = await session.send('Target.getTargets' as never) as {
    targetInfos: Array<{ type: string }>;
  };
  return targetInfos.some((target) => target.type === 'service_worker');
}

/**
 * The analysis outbox as the data plane wrote it, read from IndexedDB on an
 * extension page — which does **not** wake the service worker. That is the
 * point: it is how the test watches for completion while keeping it dead.
 *
 * IndexedDB, because that is where the outbox actually lives. An offscreen
 * document has no `chrome.storage`; an earlier version of this helper read
 * `chrome.storage.local`, found nothing, and let an assertion pass vacuously.
 */
async function outboxRows(controlPage: Page): Promise<Array<{ id: string; status: string }>> {
  return controlPage.evaluate(() => new Promise<Array<{ id: string; status: string }>>((resolve, reject) => {
    const open = indexedDB.open('analysis-job-outbox');
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => {
      // Opened before the data plane ever wrote: create nothing, answer empty.
      open.transaction?.abort();
      resolve([]);
    };
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('jobs')) { db.close(); resolve([]); return; }
      const request = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
      request.onsuccess = () => {
        db.close();
        resolve((request.result as any[]).map((job) => ({ id: job.id, status: job.status })));
      };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
}

/**
 * Whether an analysis row is on disk, read straight from IndexedDB. Also from
 * the extension page, for the same reason: asking background would revive it.
 */
async function analysisStored(controlPage: Page, historyId: string): Promise<boolean> {
  return controlPage.evaluate((id) => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('recording-history');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('analyses')) { db.close(); resolve(false); return; }
      const request = db.transaction('analyses', 'readonly').objectStore('analyses').get(id);
      request.onsuccess = () => { db.close(); resolve(request.result != null); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), historyId);
}

/**
 * Holds a `readwrite` transaction on the `analyses` store open from the control
 * page, until released.
 *
 * IndexedDB serializes overlapping `readwrite` transactions across every
 * connection on the origin, so background's write of a result **queues**
 * behind this one. That is what makes the completed-but-unstored window
 * deterministic rather than something to race: background has received the
 * result, cannot store it, and will not acknowledge it, for as long as the
 * test likes. The transaction is kept alive by an unbroken chain of requests,
 * since an idle one auto-commits.
 */
async function holdAnalysesStore(controlPage: Page): Promise<void> {
  await controlPage.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('recording-history');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('analyses', 'readwrite');
      const store = transaction.objectStore('analyses');
      const state = { held: true };
      const spin = () => {
        if (!state.held) return;
        store.get('__durability_test_hold__').onsuccess = spin;
      };
      spin();
      transaction.oncomplete = () => db.close();
      (globalThis as any).__releaseAnalysesStore = () => { state.held = false; };
      resolve();
    };
  }));
}

async function releaseAnalysesStore(controlPage: Page): Promise<void> {
  await controlPage.evaluate(() => (globalThis as any).__releaseAnalysesStore?.());
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
      // analysis must leave no terminal job behind. (This used to read
      // `chrome.storage.local`, where the outbox never wrote anything — the
      // assertion passed without checking what it claimed to.)
      await expect.poll(
        async () => (await outboxRows(harness.controlPage)).length,
        { message: 'a terminal analysis job was never acknowledged', timeout: 15_000 },
      ).toBe(0);

      await meetPage.close().catch(() => {});
    } finally {
      await closeHarness(harness);
    }
  });

  /**
   * The narrower window the first test cannot reach: the job has **finished**
   * and its result exists only in the offscreen document, but background has
   * not yet stored it.
   *
   * This is where release-on-delivery lost analyses. The data plane used to
   * drop its copy as soon as `postMessage` returned, which says the message
   * left — not that anything was persisted. A worker killed after that and
   * before the IndexedDB write took the only copy with it.
   *
   * **How the window is reached.** The worker is killed repeatedly from shortly
   * after the stop, while the control page watches `chrome.storage.local` for
   * the job's `completed` outbox row — which the data plane writes *before* it
   * delivers anything. The moment that row appears the worker is killed once
   * more, and IndexedDB is read directly to confirm nothing was stored. Both
   * reads come from an extension page, so neither revives the worker.
   *
   * **The guard.** If the analysis is already on disk when the completed row is
   * first seen, the run never entered the window and proves nothing; the test
   * says so rather than passing.
   */
  test('keeps a finished analysis whose service worker dies before storing it', async ({}, testInfo) => {
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
      const stoppedAt = Date.now();

      // Hold the store before the job can finish, so its result cannot land.
      await holdAnalysesStore(harness.controlPage);
      expect(await outboxRows(harness.controlPage), 'the analysis finished before the store was held').toEqual([]);

      const session = await harness.context.newCDPSession(harness.controlPage);
      await session.send('ServiceWorker.enable' as never);

      // The worker stays alive throughout, so it genuinely receives the result.
      let completed: { id: string; status: string } | undefined;
      const deadline = Date.now() + 120_000;
      while (!completed && Date.now() < deadline) {
        await harness.controlPage.waitForTimeout(200);
        completed = (await outboxRows(harness.controlPage)).find((row) => row.status === 'completed');
      }
      expect(completed, 'the analysis never reached a completed state').toBeTruthy();
      const analysisMs = Date.now() - stoppedAt;

      // Give background ample time to receive the result and block on the
      // store. Under release-on-delivery, the data plane has dropped its copy
      // by now; that is precisely the state the rest of this test examines.
      await harness.controlPage.waitForTimeout(1_500);

      // The guard: the job is finished and its row is still unacknowledged —
      // background has not stored it. Otherwise this run proves nothing.
      expect((await outboxRows(harness.controlPage)).map((row) => row.status)).toEqual(['completed']);

      // Kill the worker mid-write, and prove it is gone.
      let dead = false;
      for (let attempt = 0; attempt < 40 && !dead; attempt += 1) {
        await killServiceWorker(session);
        dead = !(await workerAlive(session));
        if (!dead) await harness.controlPage.waitForTimeout(25);
      }
      expect(dead, 'the service worker never went away — nothing was actually killed').toBe(true);

      // Release the store, and confirm the queued write died with the worker.
      await releaseAnalysesStore(harness.controlPage);
      await harness.controlPage.waitForTimeout(300);
      expect(
        await analysisStored(harness.controlPage, historyId),
        'the result was stored despite the worker dying — this run never tested the window',
      ).toBe(false);

      // Let it come back. The only copy of the result is in offscreen memory;
      // it must be re-offered, stored, and acknowledged.
      const releasedAt = Date.now();
      let topics: Manifest['topics'] | null = null;
      while (!topics?.length && Date.now() - releasedAt < 120_000) {
        await harness.controlPage.waitForTimeout(250);
        topics = await manifestTopics(harness.controlPage, historyId).catch(() => null);
      }
      const recoveryMs = Date.now() - releasedAt;

      expect(topics, 'a finished analysis was lost when its service worker died before storing it').toBeTruthy();
      expect(topics!.length).toBeGreaterThan(0);
      expect(await analysisStored(harness.controlPage, historyId)).toBe(true);

      /*
       * *How* it came back is the actual assertion.
       *
       * A lost result is not the end of the world any more: the data plane
       * reports it, and background re-runs the analysis from the transcript. So
       * "topics eventually appear" holds whether the held result was redelivered
       * or thrown away and recomputed — and only the first is correct here.
       *
       * The two are far apart in time. Redelivery is a reconnect and one write.
       * Recomputing repeats the whole run, which took `analysisMs` the first
       * time. Half of that is a bound only redelivery can meet.
       */
      // eslint-disable-next-line no-console
      console.log(`    analysis took ${analysisMs} ms; recovery after the kill took ${recoveryMs} ms`);
      expect(
        recoveryMs,
        `recovery took ${recoveryMs} ms against an original run of ${analysisMs} ms — that is a recomputation, `
        + 'which means the held result was released before it was stored',
      ).toBeLessThan(analysisMs / 2);

      // Stored and acknowledged: nothing left to replay.
      await expect.poll(
        async () => (await outboxRows(harness.controlPage)).length,
        { message: 'the completed job was never acknowledged', timeout: 15_000 },
      ).toBe(0);

      await meetPage.close().catch(() => {});
    } finally {
      await closeHarness(harness);
    }
  });
});