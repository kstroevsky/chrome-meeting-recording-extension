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

/**
 * The whole ADR-0006 chain, in one pass: capture writes to `staging/`, local
 * finalization promotes into `library/`, history records the OPFS replica, and
 * the player reads those bytes back through a real media element.
 *
 * This is the case unit tests structurally cannot cover — they mock `File`, and
 * the bug that shipped past them was a `File` invalidated by `move()`.
 */
test.describe('recording playback (integration)', () => {
  test('promotes a local recording and plays it back from the retained copy', async ({}, testInfo) => {
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

      await meetPage.waitForTimeout(1_500);
      const marked = await sendRuntimeMessage<{ ok: boolean }>(
        harness.controlPage,
        { type: 'MARK_NOTATION', text: 'decision point' },
      );
      expect(marked.ok).toBe(true);
      await meetPage.waitForTimeout(800);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });

      // Promotion really happened: the bytes are under `library/`, not `staging/`.
      const retained = await expect.poll(async () => await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
          const out: string[] = [];
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            try {
              const file = await (await dir.getFileHandle(name)).getFile();
              out.push(`${prefix}${name}:${file.size}`);
            } catch {
              const child = await dir.getDirectoryHandle(name);
              out.push(...await walk(child, `${prefix}${name}/`));
            }
          }
          return out;
        };
        return await walk(root, '');
      }), { timeout: 25_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^library\/.+:\d+$/)]));
      void retained;

      // Play, and confirm the element got real bytes rather than an empty src.
      await page.locator('.recording-row__play').first().click();
      const player = page.locator('.player');
      await expect(player).toBeVisible();

      const video = page.locator('.player__video');
      await expect.poll(async () => await video.getAttribute('src'), { timeout: 20_000 })
        .toMatch(/^blob:/);

      // The picture is not merely present — the media stack parsed it.
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 20_000,
      }).toBeGreaterThanOrEqual(1);

      /*
       * Deliberately not asserted against `el.duration`. The WebM duration fix
       * produces a new in-memory Blob that goes to Downloads and Drive, while
       * the bytes retained in OPFS keep the unfixed header — so the element
       * reports `Infinity` here. The player takes its total from the manifest's
       * recorded duration instead, which is the better source anyway: it is
       * pause-aware (ADR-0005), and a container duration is not.
       */
      await expect(page.locator('.player__clock')).toHaveText(/^0:00 \/ \d+:\d{2}$/);
      await expect(page.locator('.player__clock')).not.toHaveText('0:00 / 0:00');

      // No failure banner over the picture.
      await expect(page.locator('.player__status')).toBeHidden();

      // It actually plays, rather than merely loading.
      await video.evaluate(async (el: HTMLVideoElement) => { await el.play().catch(() => {}); });
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.currentTime), {
        timeout: 15_000,
      }).toBeGreaterThan(0);
      await video.evaluate((el: HTMLVideoElement) => el.pause());

      // An un-cued container still seeks locally, because the whole file is on disk.
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) =>
        el.seekable.length ? el.seekable.end(0) : 0), { timeout: 10_000 }).toBeGreaterThan(0);

      // The note is on the scrubber and is a seek target.
      const mark = page.locator('.player__mark').first();
      await expect(mark).toBeVisible();
      await mark.click();

      // Closing releases the object URL rather than leaving the file pinned.
      await page.locator('.player__close').click();
      await expect(player).toHaveCount(0);
    } finally {
      await closeHarness(harness);
    }
  });
});
