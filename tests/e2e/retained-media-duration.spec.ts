import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';

/**
 * MediaRecorder writes WebM with no Duration element, so a raw capture reports
 * `duration === Infinity` and cannot be seeked. The OPFS worker repairs that on
 * close — but the repair has to reach the *file*, not just the Blob it hands
 * back, because promotion moves the file into the retained library and that is
 * what the player opens and what the local download delivers.
 */
test.describe('retained media (integration)', () => {
  test('the retained library copy carries a real duration, so the player can seek', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'off', recordSelfVideo: false,
      });
      await meetPage.waitForTimeout(3_000);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });

      /** Loads the first retained library file into a video element. */
      const probeLibrary = async () => await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const library = await root.getDirectoryHandle('library').catch(() => null);
        if (!library) return null;
        for await (const owner of (library as unknown as { keys(): AsyncIterable<string> }).keys()) {
          const dir = await library.getDirectoryHandle(owner);
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            if (!name.endsWith('.webm')) continue;
            const file = await (await dir.getFileHandle(name)).getFile();
            const duration = await new Promise<number | string>((resolve) => {
              const video = document.createElement('video');
              video.preload = 'metadata';
              video.onloadedmetadata = () => { resolve(video.duration); URL.revokeObjectURL(video.src); };
              video.onerror = () => resolve('decode-error');
              video.src = URL.createObjectURL(file);
              setTimeout(() => resolve('timeout'), 8_000);
            });
            return { name, bytes: file.size, duration };
          }
        }
        return null;
      });

      await expect.poll(probeLibrary, { timeout: 30_000 }).not.toBeNull();
      const probed = (await probeLibrary())!;

      // The whole point: not Infinity, and close to how long we recorded.
      expect(typeof probed.duration).toBe('number');
      const duration = probed.duration as number;
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0.5);
      expect(duration).toBeLessThan(30);
    } finally {
      await closeHarness(harness);
    }
  });
});
