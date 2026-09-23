import { chromium, expect, test, type Page } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  restartExtensionHarness,
  saveRecordingSettings,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
  type ExtensionHarness,
} from './helpers/extensionHarness';
import { installDriveSimulator, setDriveMediaContent } from './helpers/driveSimulator';
import { sharingE2EOrigin, startSharingWorker, type SharingWorkerHarness } from './helpers/sharingWorker';

test.describe('sharing vertical slice @sharing-e2e', () => {
  test.describe.configure({ mode: 'serial' });
  test('publishes outside the page, survives Chrome restart, recovers faults, and manages the durable server registry', async ({}, testInfo) => {
    test.setTimeout(180_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    let cleanBrowser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      expect(process.env.SHARING_SERVICE_ORIGIN).toBe(sharingE2EOrigin);
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-state'));

      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'separate',
        recordSelfVideo: true,
      });
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'separate', recordSelfVideo: true,
      });
      await meet.waitForTimeout(6_000);
      await stopRecording(harness.controlPage);

      const recordings = await openRecordings(harness);
      await forceTrackOffsets(recordings, { tab: 0, mic: 3_800 });
      await recordings.reload({ waitUntil: 'domcontentloaded' });

      // The Worker commits the chunk and then loses the response. Closing the
      // owner page at the same time proves publication belongs to offscreen.
      await worker.faults({ dropNextChunkResponse: true });
      await queueFirstRecording(recordings, true);
      await expect(recordings.locator('.share-dialog__progress')).toContainText('resumable');
      await expect.poll(async () => {
        const snapshot = await listShares(recordings);
        const local = snapshot.local[0];
        if (local?.status === 'failed') {
          throw new Error(`Initial sharing publication failed: ${local.error || 'unknown error'}${snapshot.remoteError ? `; registry: ${snapshot.remoteError}` : ''}`);
        }
        return local?.status;
      }, { timeout: 20_000 }).toMatch(/uploading|finalizing|active/);
      await recordings.close();

      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 }).toBe('active');
      const firstState = await worker.state();
      expect(firstState.counters.droppedChunkResponses).toBe(1);
      expect(firstState.objects.length).toBeGreaterThanOrEqual(3);
      const firstManifest = firstState.shares[0].manifest;
      const firstStreams = firstManifest.recordings[0].tracks.map((track: any) => track.stream);
      expect(firstStreams).toEqual(expect.arrayContaining(['tab', 'mic', 'self-video']));
      expect(firstManifest.recordings[0].tracks.find((track: any) => track.stream === 'mic')?.captureStartOffsetMs).toBe(3_800);

      const snapshot = await listShares(harness.controlPage);
      const firstRemote = snapshot.remote.find((share: any) => share.id === firstState.shares[0].id);
      expect(firstRemote?.shareUrl).toMatch(/^https:\/\/127\.0\.0\.1:8791\/s\//);

      // The registry is server-backed: reopening the page after the creation
      // dialog is gone still finds the share and all management actions.
      const management = await openRecordings(harness);
      await management.click('#shared-tab');
      const firstCard = management.locator(`[data-share-id="${firstState.shares[0].id}"]`);
      await expect(firstCard).toContainText('Active');
      await expect(firstCard.getByRole('button', { name: 'Copy link' })).toBeVisible();

      // Open the capability in a browser with no extension/profile state. The
      // actual WebM produced by MediaRecorder must load in the supported MVP
      // viewer (Chromium), with Range media access and the shared playback clock.
      cleanBrowser = await chromium.launch({ channel: 'chromium', headless: process.env.PW_HEADLESS !== '0' });
      const clean = await cleanBrowser.newContext({ ignoreHTTPSErrors: true });
      const viewer = await clean.newPage();
      await viewer.goto(firstRemote.shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(viewer.locator('#recording-title')).not.toHaveText('Loading…');
      const viewerManifest = await viewer.evaluate(async () => await (await fetch('/viewer/manifest')).json());
      const tracks = viewerManifest.recordings[0].tracks as Array<any>;
      expect(tracks.every((track) => /^(video|audio)\/webm/.test(track.mimeType))).toBe(true);
      const masterId = tracks.find((track) => track.stream === 'tab').id;
      const micId = tracks.find((track) => track.stream === 'mic').id;
      const master = viewer.locator(`[data-track-id="${masterId}"]`);
      const mic = viewer.locator(`[data-track-id="${micId}"]`);
      await expect.poll(() => master.evaluate((node: HTMLMediaElement) => node.readyState), { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(() => mic.evaluate((node: HTMLMediaElement) => node.readyState), { timeout: 20_000 }).toBeGreaterThan(0);

      await viewer.evaluate(({ masterId, micId }) => {
        const master = document.querySelector<HTMLMediaElement>(`[data-track-id="${masterId}"]`)!;
        const mic = document.querySelector<HTMLMediaElement>(`[data-track-id="${micId}"]`)!;
        master.pause();
        master.currentTime = 2;
        master.dispatchEvent(new Event('seeking'));
        if (Math.abs(mic.currentTime) > 0.05 || !mic.paused) throw new Error('Mic must remain paused before +3.8 s');
        master.currentTime = 4.8;
        master.dispatchEvent(new Event('seeked'));
      }, { masterId, micId });
      expect(await mic.evaluate((node: HTMLMediaElement) => node.currentTime)).toBeCloseTo(1, 1);
      await master.evaluate((node: HTMLMediaElement) => { node.playbackRate = 1.5; });
      await expect.poll(() => mic.evaluate((node: HTMLMediaElement) => node.playbackRate)).toBe(1.5);
      await viewer.locator('input[aria-label="Mic volume"]').evaluate((input: HTMLInputElement) => {
        input.value = '0.4';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(await mic.evaluate((node: HTMLMediaElement) => node.volume)).toBeCloseTo(0.4, 2);
      const rangeStatus = await viewer.evaluate(async (endpoint) => (await fetch(endpoint, { headers: { Range: 'bytes=0-15' } })).status, tracks[0].mediaEndpoint);
      expect(rangeStatus).toBe(206);

      // A committed chunk with its response held open leaves the local durable
      // offset behind the server. Killing Chrome here exercises replay from the
      // same IndexedDB/OPFS profile after a full browser restart.
      const beforeRestart = await worker.state();
      await worker.faults({ delayNextChunkMs: 10_000 });
      const restartPage = await openRecordings(harness);
      await queueFirstRecording(restartPage, false);
      await expect.poll(async () => (await worker!.state()).counters.chunkCommits, { timeout: 30_000 })
        .toBeGreaterThan(beforeRestart.counters.chunkCommits);
      harness = await restartExtensionHarness(harness, { ignoreHTTPSErrors: true });
      await expect.poll(async () => (await worker!.state()).shares.filter((share) => share.status === 'active').length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);

      // Force one owner 401: ShareServiceClient must renew its short-lived owner
      // session and retry, while the Google identity token stays brokered by background.
      const sessionsBefore = (await worker.state()).counters.authSessions;
      await worker.faults({ ownerUnauthorizedOnce: true });
      const afterRestartPage = await openRecordings(harness);
      await afterRestartPage.click('#shared-tab');
      await expect.poll(async () => (await worker!.state()).counters.authSessions, { timeout: 20_000 })
        .toBeGreaterThan(sessionsBefore);

      // Expire the R2 multipart after begin. The uploader must abandon that
      // durable session, create a fresh one, and still finalize the share.
      const beforeExpired = await worker.state();
      await worker.faults({ expireNextUpload: true });
      await afterRestartPage.click('#recordings-tab');
      await queueFirstRecording(afterRestartPage, false);
      await expect.poll(async () => (await worker!.state()).counters.expiredUploads, { timeout: 30_000 })
        .toBeGreaterThan(beforeExpired.counters.expiredUploads);
      await expect.poll(async () => (await worker!.state()).shares.filter((share) => share.status === 'active').length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(3);
      expect((await worker.state()).counters.uploadBegins).toBeGreaterThan(beforeExpired.counters.uploadBegins + 1);
      await afterRestartPage.getByRole('button', { name: 'Close sharing dialog' }).click();

      // Revoke closes future viewer authorization without destroying the media.
      await afterRestartPage.click('#shared-tab');
      const managedFirst = afterRestartPage.locator(`[data-share-id="${firstState.shares[0].id}"]`);
      await managedFirst.getByRole('button', { name: 'Revoke' }).click();
      await expect.poll(async () => (await worker!.state()).shares.find((share) => share.id === firstState.shares[0].id)?.status)
        .toBe('revoked');
      const denied = await viewer.evaluate(async () => (await fetch('/viewer/manifest', { cache: 'no-store' })).status);
      expect(denied).toBe(410);
      expect((await worker.state()).objects.length).toBeGreaterThan(0);

      // Permanent delete is a distinct destructive operation and removes both
      // server registry metadata and R2 objects belonging to this share. Lose
      // the first successful response to prove the retry is idempotent end to end.
      await worker.faults({ dropNextDeleteResponse: true });
      afterRestartPage.once('dialog', (dialog) => void dialog.accept());
      await managedFirst.getByRole('button', { name: 'Delete published data' }).click();
      await expect.poll(async () => (await worker!.state()).shares.some((share) => share.id === firstState.shares[0].id))
        .toBe(false);
      await expect(afterRestartPage.locator(`[data-share-id="${firstState.shares[0].id}"]`)).toHaveCount(0);
      expect((await worker.state()).counters.droppedDeleteResponses).toBe(1);
    } finally {
      await cleanBrowser?.close().catch(() => {});
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });

  test('publishes a Drive-only recording through authenticated range reads', async ({}, testInfo) => {
    test.setTimeout(90_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    try {
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-state'));
      const driveStats = await installDriveSimulator(harness.context, 'fast');
      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, { recordingMode: 'opfs', micMode: 'separate', recordSelfVideo: false });
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'separate', recordSelfVideo: false,
      });
      await meet.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const page = await openRecordings(harness);
      const driveSources = await rewriteFirstRecordingAsDrive(page);
      for (const source of driveSources) {
        setDriveMediaContent(source.fileId, Buffer.from(source.base64, 'base64'), `${source.stream}.webm`);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await queueFirstRecording(page, false);

      await expect.poll(async () => {
        const snapshot = await listShares(page);
        const newest = [...snapshot.local].sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
        if (newest?.status === 'failed') {
          throw new Error(`Drive publication failed: ${newest.error || 'unknown error'}; Drive reads=${driveStats.mediaReads.length}`);
        }
        return newest?.status;
      }, { timeout: 20_000 }).toMatch(/uploading|finalizing|active/);
      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 }).toBe('active');
      expect(driveStats.mediaReads.length).toBeGreaterThanOrEqual(driveSources.length);
      expect(driveStats.mediaReads.every((read) => read.range?.startsWith('bytes=') === true)).toBe(true);
    } finally {
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });
});

async function openRecordings(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 30_000 });
  return page;
}

async function queueFirstRecording(page: Page, includeSelfVideo: boolean): Promise<void> {
  await page.locator('.recording-row').first().getByRole('button', { name: /^Select / }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  if (includeSelfVideo) {
    await page.locator('.share-dialog__option', { hasText: 'Self camera' }).locator('input').check();
  }
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('.share-dialog__progress')).toBeVisible({ timeout: 20_000 });
}

async function forceTrackOffsets(page: Page, offsets: { tab: number; mic: number }): Promise<void> {
  await page.evaluate(async (value) => {
    const db = await openDatabase();
    const tx = db.transaction('recordings', 'readwrite');
    const store = tx.objectStore('recordings');
    const entries: any[] = await requestValue(store.getAll());
    for (const entry of entries) {
      for (const file of entry.files ?? []) {
        if (file.stream === 'tab') file.captureStartOffsetMs = value.tab;
        if (file.stream === 'mic') file.captureStartOffsetMs = value.mic;
      }
      store.put(entry);
    }
    await transactionDone(tx);
    db.close();

    function openDatabase(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('recording-history');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    function requestValue<T>(request: IDBRequest<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    function transactionDone(tx: IDBTransaction): Promise<void> {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
  }, offsets);
}

async function listShares(page: Page): Promise<any> {
  const response = await sendRuntimeMessage<any>(page, { type: 'LIST_SHARES' });
  if (!response.ok) throw new Error(response.error || 'Could not list shares');
  return response.snapshot;
}

async function rewriteFirstRecordingAsDrive(
  page: Page,
): Promise<Array<{ fileId: string; stream: string; base64: string }>> {
  return await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('recording-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readTx = db.transaction('recordings', 'readonly');
    const store = readTx.objectStore('recordings');
    const entries: any[] = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      readTx.oncomplete = () => resolve();
      readTx.onerror = () => reject(readTx.error);
      readTx.onabort = () => reject(readTx.error);
    });
    const entry = entries.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!entry) throw new Error('No recording to rewrite');
    const root = await navigator.storage.getDirectory();
    const sources: Array<{ fileId: string; stream: string; base64: string }> = [];
    for (const file of entry.files ?? []) {
      if (file.kind != null) continue;
      const local = file.locations?.find((location: any) => location.kind === 'opfs');
      if (!local?.key) throw new Error(`No OPFS source for ${file.stream}`);
      const parts = String(local.key).split('/').filter(Boolean);
      let directory: FileSystemDirectoryHandle = root;
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
      const filename = parts[parts.length - 1];
      if (!filename) throw new Error(`Invalid OPFS key for ${file.stream}`);
      const blob = await (await directory.getFileHandle(filename)).getFile();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const driveFileId = `sharing-drive-${file.stream}`;
      sources.push({ fileId: driveFileId, stream: file.stream, base64: btoa(binary) });
      file.locations = [{ kind: 'drive', fileId: driveFileId }];
      file.driveFileId = driveFileId;
      file.destination = 'drive';
      file.delivery = { requested: 'drive', status: 'uploaded' };
    }
    entry.storageMode = 'drive';
    const writeTx = db.transaction('recordings', 'readwrite');
    writeTx.objectStore('recordings').put(entry);
    await new Promise<void>((resolve, reject) => {
      writeTx.oncomplete = () => resolve();
      writeTx.onerror = () => reject(writeTx.error);
      writeTx.onabort = () => reject(writeTx.error);
    });
    db.close();
    return sources;
  });
}
