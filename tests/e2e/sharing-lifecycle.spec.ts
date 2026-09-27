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
import {
  createDriveSimulatorUploadState,
  getDriveSimulatorRelayFile,
  installDriveSimulator,
  resetDriveSimulatorSharingState,
  setDriveMediaContent,
} from './helpers/driveSimulator';
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
      resetDriveSimulatorSharingState();
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      const driveStats = await installDriveSimulator(harness.context, 'fast');
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

      // Closing the owner page while Drive origins are still being prepared
      // proves publication belongs to the offscreen runtime.
      await queueFirstRecording(recordings, true);
      await expect(recordings.locator('.share-dialog__progress')).toContainText('resumable');
      await expect.poll(async () => {
        const snapshot = await listShares(recordings);
        const local = snapshot.local[0];
        if (local?.status === 'failed') {
          throw new Error(`Initial sharing publication failed: ${local.error || 'unknown error'}${snapshot.remoteError ? `; registry: ${snapshot.remoteError}` : ''}`);
        }
        return local?.status;
      }, { timeout: 20_000 }).toMatch(/preparing-origin|uploading|finalizing|active/);
      await recordings.close();

      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 }).toBe('active');
      const firstState = await worker.state();
      expect(firstState.counters.droppedOriginResponses).toBe(0);
      expect(firstState.mediaAssets.length).toBeGreaterThanOrEqual(3);
      expect(driveStats.revisionUpdates).toBeGreaterThanOrEqual(3);
      expect(driveStats.permissionCreates).toBeGreaterThanOrEqual(3);
      const firstManifest = firstState.shares[0].manifest;
      const firstStreams = firstManifest.recordings[0].tracks.map((track: any) => track.stream);
      expect(firstStreams).toEqual(expect.arrayContaining(['tab', 'mic', 'self-video']));
      expect(firstManifest.recordings[0].tracks.find((track: any) => track.stream === 'mic')?.captureStartOffsetMs).toBe(3_800);
      const firstManifestJson = JSON.stringify(firstManifest);
      for (const asset of firstState.mediaAssets.filter((asset) => asset.share_id === firstState.shares[0].id)) {
        expect(firstManifestJson).not.toContain(asset.drive_file_id);
        expect(firstManifestJson).not.toContain(asset.revision_id);
        if (asset.permission_id) expect(firstManifestJson).not.toContain(asset.permission_id);
      }

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
      await expect.poll(async () => (await worker!.state()).cacheEntries.length, { timeout: 20_000 }).toBeGreaterThan(0);

      // Lose the response after the Worker has committed one immutable Drive
      // origin. The local publication becomes resumable; a full Chrome restart
      // must replay that same origin idempotently and finish the share.
      const beforeRestart = await worker.state();
      await worker.faults({ dropNextOriginResponse: true });
      const restartPage = await openRecordings(harness);
      await queueFirstRecording(restartPage, false);
      await expect.poll(async () => (await worker!.state()).counters.droppedOriginResponses, { timeout: 30_000 })
        .toBeGreaterThan(beforeRestart.counters.droppedOriginResponses);
      await expect.poll(async () => {
        const snapshot = await listShares(restartPage);
        const newest = [...snapshot.local].sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
        return newest?.status;
      }, { timeout: 30_000 }).toBe('failed');
      harness = await restartExtensionHarness(harness, {
        ignoreHTTPSErrors: true,
        configureContext: async (context) => { await installDriveSimulator(context, 'fast'); },
      });
      await expect.poll(async () => (await worker!.state()).shares.filter((share) => share.status === 'active').length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);
      const afterRestartState = await worker.state();
      const firstShareAssets = firstState.mediaAssets.filter((asset) => asset.share_id === firstState.shares[0].id);
      const otherActiveShareIds = new Set(afterRestartState.shares
        .filter((share) => share.id !== firstState.shares[0].id && share.status === 'active')
        .map((share) => share.id));
      const otherActiveAssets = afterRestartState.mediaAssets.filter((asset) => otherActiveShareIds.has(asset.share_id));
      const hasSurvivingFileReference = (asset: (typeof firstShareAssets)[number]) =>
        otherActiveAssets.some((candidate) => candidate.drive_file_id === asset.drive_file_id);
      const hasSurvivingRevisionReference = (asset: (typeof firstShareAssets)[number]) =>
        otherActiveAssets.some((candidate) =>
          candidate.drive_file_id === asset.drive_file_id
          && candidate.revision_id === asset.revision_id);
      expect(firstShareAssets.some(hasSurvivingRevisionReference)).toBe(true);
      expect(firstShareAssets.some((asset) => !hasSurvivingRevisionReference(asset))).toBe(true);

      // Force one owner 401: ShareServiceClient must renew its short-lived owner
      // session and retry, while the Google identity token stays brokered by background.
      const sessionsBefore = (await worker.state()).counters.authSessions;
      await worker.faults({ ownerUnauthorizedOnce: true });
      const afterRestartPage = await openRecordings(harness);
      await afterRestartPage.click('#shared-tab');
      await expect.poll(async () => (await worker!.state()).counters.authSessions, { timeout: 20_000 })
        .toBeGreaterThan(sessionsBefore);

      // Revoke closes this viewer authorization first. The restarted second
      // publication reuses these origins, so their relay permission must stay.
      const managedFirst = afterRestartPage.locator(`[data-share-id="${firstState.shares[0].id}"]`);
      const firstAssets = firstShareAssets;
      await managedFirst.getByRole('button', { name: 'Revoke' }).click();
      await expect.poll(async () => (await worker!.state()).shares.find((share) => share.id === firstState.shares[0].id)?.status)
        .toBe('revoked');
      const denied = await viewer.evaluate(async () => (await fetch('/viewer/manifest', { cache: 'no-store' })).status);
      expect(denied).toBe(410);
      await expect.poll(() => firstAssets.every((asset) =>
        getDriveSimulatorRelayFile(asset.drive_file_id)?.permissions.length
          === (hasSurvivingFileReference(asset) ? 1 : 0)), { timeout: 20_000 }).toBe(true);
      for (const asset of firstAssets) {
        expect(getDriveSimulatorRelayFile(asset.drive_file_id)).toBeDefined();
      }

      // Delete removes this publication's metadata/cache while the shared
      // revision stays pinned for the surviving publication. Lose the first
      // successful server response to prove cleanup is idempotent end to end.
      await worker.faults({ dropNextDeleteResponse: true });
      afterRestartPage.once('dialog', (dialog) => void dialog.accept());
      await managedFirst.getByRole('button', { name: 'Delete published data' }).click();
      await expect.poll(async () => (await worker!.state()).shares.some((share) => share.id === firstState.shares[0].id))
        .toBe(false);
      await expect(afterRestartPage.locator(`[data-share-id="${firstState.shares[0].id}"]`)).toHaveCount(0);
      expect((await worker.state()).counters.droppedDeleteResponses).toBe(1);
      await expect.poll(() => firstAssets.every((asset) =>
        getDriveSimulatorRelayFile(asset.drive_file_id)?.keepForever === hasSurvivingRevisionReference(asset)), {
        timeout: 20_000,
      }).toBe(true);
      const afterDelete = await worker.state();
      expect(afterDelete.mediaAssets.some((asset) => asset.share_id === firstState.shares[0].id)).toBe(false);
      expect(afterDelete.cacheEntries.some((entry) => firstAssets.some((asset) => asset.id === entry.asset_id))).toBe(false);
      for (const asset of firstAssets) expect(getDriveSimulatorRelayFile(asset.drive_file_id)).toBeDefined();
    } finally {
      await cleanBrowser?.close().catch(() => {});
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });

  test('keeps idle offscreen sharing alive across a >60 second origin response', async ({}, testInfo) => {
    test.setTimeout(150_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    try {
      resetDriveSimulatorSharingState();
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      await installDriveSimulator(harness.context, 'fast');
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-soak-state'));

      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'separate',
        recordSelfVideo: false,
      });
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'separate', recordSelfVideo: false,
      });
      await meet.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const before = await worker.state();
      await worker.faults({ delayNextOriginMs: 65_000 });
      const recordings = await openRecordings(harness);
      await queueFirstRecording(recordings, false);
      await expect.poll(async () => (await worker!.state()).counters.originRegistrations, { timeout: 20_000 })
        .toBeGreaterThan(before.counters.originRegistrations);
      await recordings.close();

      await harness.controlPage.waitForTimeout(40_000);
      expect(await hasOffscreenContext(harness.controlPage)).toBe(true);

      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 })
        .toBe('active');
      expect(await hasOffscreenContext(harness.controlPage)).toBe(true);
    } finally {
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });

  test('resumes the same OPFS Drive upload after Chrome dies with server-committed bytes', async ({}, testInfo) => {
    test.setTimeout(120_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    try {
      resetDriveSimulatorSharingState();
      const uploadState = createDriveSimulatorUploadState();
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      const beforeRestart = await installDriveSimulator(harness.context, 'partial-commit', {
        throttleMs: 10_000,
        uploadState,
      });
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-upload-restart-state'));

      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await meet.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const recordings = await openRecordings(harness);
      await queueFirstRecording(recordings, false);
      await expect.poll(() => beforeRestart.uploadedBytes, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(beforeRestart.sessionsCreated).toBe(1);
      expect(beforeRestart.dataPuts).toBe(1);

      // Drive has committed roughly half of the first request, but the delayed
      // response has not reached the extension, so its persisted local offset
      // is still the pre-request value when Chrome exits.
      const persistedBefore = await sharingUploadJobs(recordings);
      expect(persistedBefore).toHaveLength(1);
      expect(persistedBefore[0].uploadId).toContain('/upload/mock-drive-session/1');
      expect(persistedBefore[0].offset).toBe(0);

      let afterRestartStats: Awaited<ReturnType<typeof installDriveSimulator>> | null = null;
      harness = await restartExtensionHarness(harness, {
        ignoreHTTPSErrors: true,
        configureContext: async (context) => {
          afterRestartStats = await installDriveSimulator(context, 'fast', { uploadState });
        },
      });

      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 }).toBe('active');
      expect(afterRestartStats).not.toBeNull();
      expect(afterRestartStats!.sessionsCreated).toBe(0);
      expect(afterRestartStats!.statusProbes).toBeGreaterThanOrEqual(1);
      expect(afterRestartStats!.requests.some((request) =>
        request.method === 'PUT'
        && request.url.includes('/upload/mock-drive-session/1')
        && request.contentRange?.startsWith('bytes */'))).toBe(true);
      expect(afterRestartStats!.requests.some((request) =>
        request.method === 'PUT'
        && request.url.includes('/upload/mock-drive-session/1')
        && /^bytes [1-9]\d*-/.test(request.contentRange ?? ''))).toBe(true);

      const state = await worker.state();
      expect(state.mediaAssets).toHaveLength(1);
      const uploaded = getDriveSimulatorRelayFile(state.mediaAssets[0].drive_file_id);
      expect(uploaded).toBeDefined();
      expect(uploaded!.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });

  test('reuses a Drive-only recording without re-uploading media', async ({}, testInfo) => {
    test.setTimeout(90_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    try {
      resetDriveSimulatorSharingState();
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      const driveStats = await installDriveSimulator(harness.context, 'fast');
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-state'));
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
      const sessionsBefore = driveStats.sessionsCreated;
      const mediaReadsBefore = driveStats.mediaReads.length;
      await queueFirstRecording(page, false);

      await expect.poll(async () => {
        const snapshot = await listShares(page);
        const newest = [...snapshot.local].sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
        if (newest?.status === 'failed') {
          throw new Error(`Drive publication failed: ${newest.error || 'unknown error'}; Drive reads=${driveStats.mediaReads.length}`);
        }
        return newest?.status;
      }, { timeout: 20_000 }).toMatch(/preparing-origin|uploading|finalizing|active/);
      await expect.poll(async () => (await worker!.state()).shares[0]?.status, { timeout: 60_000 }).toBe('active');
      expect(driveStats.sessionsCreated).toBe(sessionsBefore);
      expect(driveStats.mediaReads.length).toBe(mediaReadsBefore);
      expect(driveStats.revisionUpdates).toBeGreaterThanOrEqual(driveSources.length);
      expect(driveStats.permissionCreates).toBeGreaterThanOrEqual(driveSources.length);
      expect((await worker.state()).mediaAssets).toHaveLength(driveSources.length);
    } finally {
      await worker?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });

  test('reuses one OPFS Drive origin across shares and cleans it only after the last share', async ({}, testInfo) => {
    test.setTimeout(120_000);
    let harness: ExtensionHarness | null = null;
    let worker: SharingWorkerHarness | null = null;
    try {
      resetDriveSimulatorSharingState();
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { ignoreHTTPSErrors: true });
      const driveStats = await installDriveSimulator(harness.context, 'fast');
      worker = await startSharingWorker(harness.extensionId, testInfo.outputPath('sharing-worker-shared-origin-state'));

      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await meet.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const firstPage = await openRecordings(harness);
      await queueFirstRecording(firstPage, false);
      await expect.poll(async () => (await worker!.state()).shares.filter((share) => share.status === 'active').length, {
        timeout: 60_000,
      }).toBe(1);
      const afterFirst = await worker.state();
      const firstShareId = afterFirst.shares.find((share) => share.status === 'active')!.id;
      const firstAsset = afterFirst.mediaAssets.find((asset) => asset.share_id === firstShareId)!;
      expect(firstAsset).toBeDefined();
      expect(driveStats.sessionsCreated).toBe(1);

      const secondPage = await openRecordings(harness);
      await queueFirstRecording(secondPage, false);
      await expect.poll(async () => (await worker!.state()).shares.filter((share) => share.status === 'active').length, {
        timeout: 60_000,
      }).toBe(2);

      const afterSecond = await worker.state();
      const secondShare = afterSecond.shares.find((share) => share.id !== firstShareId && share.status === 'active')!;
      const secondAsset = afterSecond.mediaAssets.find((asset) => asset.share_id === secondShare.id)!;
      expect(secondAsset).toBeDefined();
      expect(secondAsset.drive_file_id).toBe(firstAsset.drive_file_id);
      expect(secondAsset.revision_id).toBe(firstAsset.revision_id);
      expect(secondAsset.permission_id).toBe(firstAsset.permission_id);
      expect(driveStats.sessionsCreated).toBe(1);

      const registry = await listShares(secondPage);
      const secondRemote = registry.remote.find((share: any) => share.id === secondShare.id);
      expect(secondRemote?.shareUrl).toBeTruthy();
      await secondPage.getByRole('button', { name: 'Done', exact: true }).click();

      await secondPage.click('#shared-tab');
      const firstCard = secondPage.locator(`[data-share-id="${firstShareId}"]`);
      await firstCard.getByRole('button', { name: 'Revoke' }).click();
      await expect.poll(async () => (await worker!.state()).shares.find((share) => share.id === firstShareId)?.status, {
        timeout: 20_000,
      }).toBe('revoked');
      await expect.poll(() => getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.permissions.length, {
        timeout: 20_000,
      }).toBe(1);
      expect(getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.keepForever).toBe(true);

      const viewer = await harness.context.newPage();
      await viewer.goto(secondRemote.shareUrl, { waitUntil: 'domcontentloaded' });
      const viewerManifest = await viewer.evaluate(async () => await (await fetch('/viewer/manifest')).json());
      const endpoint = viewerManifest.recordings[0].tracks[0].mediaEndpoint as string;
      expect(await viewer.evaluate(async (mediaEndpoint) => (
        await fetch(mediaEndpoint, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' })
      ).status, endpoint)).toBe(206);

      secondPage.once('dialog', (dialog) => void dialog.accept());
      await firstCard.getByRole('button', { name: 'Delete published data' }).click();
      await expect.poll(async () => (await worker!.state()).shares.some((share) => share.id === firstShareId), {
        timeout: 20_000,
      }).toBe(false);
      expect(getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.permissions).toHaveLength(1);
      expect(getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.keepForever).toBe(true);
      expect(await viewer.evaluate(async (mediaEndpoint) => (
        await fetch(mediaEndpoint, { headers: { Range: 'bytes=1-1' }, cache: 'no-store' })
      ).status, endpoint)).toBe(206);

      const secondCard = secondPage.locator(`[data-share-id="${secondShare.id}"]`);
      secondPage.once('dialog', (dialog) => void dialog.accept());
      await secondCard.getByRole('button', { name: 'Delete published data' }).click();
      await expect.poll(async () => (await worker!.state()).shares.some((share) => share.id === secondShare.id), {
        timeout: 20_000,
      }).toBe(false);
      await expect.poll(() => getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.permissions.length, {
        timeout: 20_000,
      }).toBe(0);
      await expect.poll(() => getDriveSimulatorRelayFile(firstAsset.drive_file_id)?.keepForever, {
        timeout: 20_000,
      }).toBe(false);
      expect(getDriveSimulatorRelayFile(firstAsset.drive_file_id)).toBeDefined();
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

async function sharingUploadJobs(page: Page): Promise<any[]> {
  return await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('published-share-uploads');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('jobs')) {
      db.close();
      return [];
    }
    const tx = db.transaction('jobs', 'readonly');
    const values: unknown[] = await new Promise((resolve, reject) => {
      const request = tx.objectStore('jobs').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return values.filter((value): value is Record<string, unknown> =>
      value != null && typeof value === 'object');
  });
}

async function hasOffscreenContext(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((query: { contextTypes: string[] }) => Promise<unknown[]>)
      | undefined;
    if (!getContexts) throw new Error('chrome.runtime.getContexts is unavailable');
    return (await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
  });
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
