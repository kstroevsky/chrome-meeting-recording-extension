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
 * Independently started `MediaRecorder`s do not share a timeline origin. Capture
 * measures how far after the run each one actually began, and history keeps it,
 * so playback lines the tracks up instead of assuming they started together.
 */
test.describe('track offsets (integration)', () => {
  test('capture measures a per-track start offset and history keeps it', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'separate', recordSelfVideo: false,
      });
      await meetPage.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });

      const readOffsets = async () => await page.evaluate(async () => {
        const res: any = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'LIST_RECORDING_HISTORY' }, resolve));
        const files = res?.entries?.[0]?.files ?? [];
        return files
          .filter((file: any) => file.kind !== 'notes')
          .map((file: any) => [file.stream, file.captureStartOffsetMs]);
      });

      await expect.poll(async () => (await readOffsets()).length, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2);
      const offsets: [string, number | undefined][] = await readOffsets();

      // Every media track carries a measured offset — not left undefined, which
      // is what "capture never produced them" looked like.
      for (const [stream, offset] of offsets) {
        expect(`${stream}:${typeof offset}`).toBe(`${stream}:number`);
        expect(Number.isFinite(offset!)).toBe(true);
        // Sane magnitude: recorders start within the run, not minutes from it.
        expect(Math.abs(offset!)).toBeLessThan(30_000);
      }

      // Measured, not defaulted: a recorder takes real time to start, so at
      // least one offset must be off zero. Guards a regression to a constant.
      expect(offsets.some(([, offset]) => offset! > 0)).toBe(true);

      // And they are relative to the run, so the gap between two tracks is the
      // difference — which is what the player re-bases on.
      const byStream = Object.fromEntries(offsets);
      if (byStream.tab != null && byStream.mic != null) {
        expect(Math.abs(byStream.mic - byStream.tab)).toBeLessThan(5_000);
      }
    } finally {
      await closeHarness(harness);
    }
  });
});
