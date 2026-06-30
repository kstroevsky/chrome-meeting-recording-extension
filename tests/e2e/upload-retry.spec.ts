import { expect, test, type Page } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  getDownloads,
  getRecordingSession,
  launchExtensionHarness,
  openMockMeetPage,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
} from './helpers/extensionHarness';
import { installDriveSimulator } from './helpers/driveSimulator';

/**
 * Integration coverage for the "Retry upload" feature (ADR-0004) against the real
 * offscreen document, OPFS/Worker storage, port RPC, and the Drive simulator — the
 * runtime stack the unit tests mock. The headline thing proven here is the
 * assumption retry rests on: that the sealed bytes are still retryable in-memory
 * after a fallback. It also locks in the failsafe and the no-duplicate-download fix.
 */

type UploadJob = { id: string; status: string; startedAt: number; files: { status: string }[] };

async function uploadJobs(controlPage: Page): Promise<UploadJob[]> {
  const session = (await getRecordingSession(controlPage)) as unknown as { uploadJobs?: UploadJob[] };
  return session.uploadJobs ?? [];
}

async function waitForJob(
  controlPage: Page,
  predicate: (job: UploadJob) => boolean,
  timeoutMs = 45_000
): Promise<UploadJob> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = (await uploadJobs(controlPage)).find(predicate);
    if (job) return job;
    await controlPage.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for an upload job to reach the expected state');
}

async function completedDownloadCount(controlPage: Page): Promise<number> {
  return (await getDownloads(controlPage)).filter((d) => d.state === 'complete' && d.exists !== false).length;
}

async function recordOneDriveFile(harness: Awaited<ReturnType<typeof launchExtensionHarness>>): Promise<void> {
  await openMockMeetPage(harness.context);
  const meetTabId = await findMockMeetTabId(harness.controlPage);
  // mic off + no camera ⇒ exactly one (tab) artifact, so a single upload job/file.
  await startRecording(harness.controlPage, meetTabId, { storageMode: 'drive', micMode: 'off', recordSelfVideo: false });
  await harness.controlPage.waitForTimeout(1_500);
  await stopRecording(harness.controlPage); // decoupled (ADR-0004): idles at once, upload runs as a job
}

test.describe('upload retry (integration)', () => {
  test('a failed Drive upload downloads locally, then Retry re-uploads from the retained bytes', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await installDriveSimulator(harness.context, 'permanent-failure');
      await recordOneDriveFile(harness);

      // The upload fails → the file falls back to a local download (the failsafe).
      const failed = await waitForJob(harness.controlPage, (j) => j.status === 'failed' || j.status === 'partial');
      expect(await waitForCompletedDownloads(harness.controlPage, harness.downloadsDir, 1, 45_000)).toHaveLength(1);

      // Now let Drive accept the retry. A fresh simulator with the 'fast' profile.
      await harness.context.unroute('https://www.googleapis.com/**');
      const okStats = await installDriveSimulator(harness.context, 'fast');

      const retry = await sendRuntimeMessage<{ ok: boolean }>(harness.controlPage, { type: 'RETRY_UPLOAD_JOB', jobId: failed.id });
      expect(retry.ok).toBe(true);

      // Proves the core runtime assumption: the retained (Worker target ⇒ in-memory)
      // bytes were still uploadable, so the retry actually lands the file in Drive.
      await waitForJob(harness.controlPage, (j) => j.id === failed.id && j.status === 'completed', 45_000);
      expect(okStats.sessionsCreated).toBeGreaterThanOrEqual(1);
      expect(okStats.dataPuts).toBeGreaterThanOrEqual(1);

      // A successful retry uploaded to Drive — no second local download.
      expect(await completedDownloadCount(harness.controlPage)).toBe(1);
    } finally {
      await closeHarness(harness);
    }
  });

  test('a retry that fails again does not produce a duplicate local download', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      // Drive stays broken for the whole test, so the retry re-fails too.
      await installDriveSimulator(harness.context, 'permanent-failure');
      await recordOneDriveFile(harness);

      const failed = await waitForJob(harness.controlPage, (j) => j.status === 'failed' || j.status === 'partial');
      expect(await waitForCompletedDownloads(harness.controlPage, harness.downloadsDir, 1, 45_000)).toHaveLength(1);
      expect(await completedDownloadCount(harness.controlPage)).toBe(1);

      const retry = await sendRuntimeMessage<{ ok: boolean }>(harness.controlPage, { type: 'RETRY_UPLOAD_JOB', jobId: failed.id });
      expect(retry.ok).toBe(true);

      // The retry re-enqueues under the same id with a fresh startedAt, then re-settles
      // failed. Wait for that second settle so any (suppressed) download would have fired.
      await waitForJob(
        harness.controlPage,
        (j) => j.id === failed.id && j.startedAt > failed.startedAt && (j.status === 'failed' || j.status === 'partial'),
        45_000
      );

      // skipLocalFallback on retry: still exactly one local copy, not two.
      expect(await completedDownloadCount(harness.controlPage)).toBe(1);
    } finally {
      await closeHarness(harness);
    }
  });
});
