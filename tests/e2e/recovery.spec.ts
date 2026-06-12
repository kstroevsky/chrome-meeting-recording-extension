import { expect, test } from '@playwright/test';
import {
  closeHarness,
  getDownloads,
  launchExtensionHarness,
} from './helpers/extensionHarness';
import { installDriveSimulator } from './helpers/driveSimulator';

/**
 * Integration coverage for crash recovery. The mock harness's recorder tab lacks
 * chrome.storage, so recovery can't auto-fire there; instead we drive the
 * recovery entry points from the settings page (which has chrome.storage + OPFS)
 * via the e2e-only `window.__recoveryTest` bridge, against real OPFS, real
 * markers, real duration-fix, and the Drive simulator.
 */
test.describe('crash recovery (integration)', () => {
  test('resumes an interrupted Drive upload and downloads an orphaned recording', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const driveStats = await installDriveSimulator(harness.context, 'fast');

      const RESUME = 'google-meet-resumexy-20200101T0000-recording.webm';
      const ORPHAN = 'google-meet-orphanxy-20200101T0000-recording.webm';
      const FOLDER = 'google-meet-resumexy-20200101T0000';
      const MARKER_KEY = `pendingDriveUpload:${RESUME}`;

      // Seed OPFS with a real WebM (so the duration re-fix succeeds), a pending
      // upload marker (for #1), and an unmarked orphan (for #2).
      await harness.controlPage.evaluate(async ({ resume, orphan, folder, markerKey }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d')!;
        const stream = canvas.captureStream(10);
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : 'video/webm';
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
        recorder.start();
        const draw = setInterval(() => {
          ctx.fillStyle = `hsl(${Date.now() % 360}, 80%, 50%)`;
          ctx.fillRect(0, 0, 320, 240);
        }, 50);
        await new Promise((r) => setTimeout(r, 1_000));
        clearInterval(draw);
        recorder.stop();
        await stopped;
        stream.getTracks().forEach((t) => t.stop());
        const webm = new Blob(chunks, { type: 'video/webm' });

        const root = await navigator.storage.getDirectory();
        for (const name of [resume, orphan]) {
          const handle = await root.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(webm);
          await writable.close();
        }
        await chrome.storage.local.set({
          [markerKey]: { opfsFilename: resume, filename: resume, stream: 'tab', recordingFolderName: folder },
        });
      }, { resume: RESUME, orphan: ORPHAN, folder: FOLDER, markerKey: MARKER_KEY });

      await harness.controlPage.waitForFunction(
        () => (window as any).__recoveryTest != null,
        { timeout: 10_000 }
      );

      // #1 — resume the interrupted Drive upload (re-fix raw OPFS, fresh session).
      await harness.controlPage.evaluate(() => (window as any).__recoveryTest.resumeUploads());
      await expect.poll(() => driveStats.sessionsCreated, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      expect(driveStats.dataPuts).toBeGreaterThanOrEqual(1);

      // The marker is cleared once the re-upload succeeds.
      const marker = await harness.controlPage.evaluate(
        (key) => new Promise((res) => chrome.storage.local.get(key, (v) => res(v[key] ?? null))),
        MARKER_KEY
      );
      expect(marker).toBeNull();

      // #2 — recover the orphan (cutoff in the future so the just-seeded file qualifies).
      await harness.controlPage.evaluate(
        (cutoff) => (window as any).__recoveryTest.recoverOrphans(cutoff),
        Date.now() + 60_000
      );

      // Recovery sealed the orphan and handed it to the save flow...
      const saves = await harness.controlPage.evaluate(() => (window as any).__recoverySaves ?? []);
      expect(saves).toContain(ORPHAN);

      // ...and a real download completed.
      await expect.poll(async () => {
        const items = await getDownloads(harness.controlPage);
        return items.filter((i) => i.state === 'complete').length;
      }, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    } finally {
      await closeHarness(harness);
    }
  });
});
