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

  test('plays a mic and camera recording with every track on the tab clock', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'separate',
        recordSelfVideo: true,
      });
      await meetPage.waitForTimeout(1_800);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });
      await page.locator('.recording-row__play').first().click();
      await expect(page.locator('.player')).toBeVisible();

      const video = page.locator('.player__video');
      await expect.poll(async () => await video.getAttribute('src'), { timeout: 20_000 }).toMatch(/^blob:/);

      // Every retained track is attached, not just the picture.
      await expect.poll(async () => await page.locator('.player__selfcam').getAttribute('src'), {
        timeout: 20_000,
      }).toMatch(/^blob:/);
      await expect.poll(async () => await page.locator('.player audio').getAttribute('src'), {
        timeout: 20_000,
      }).toMatch(/^blob:/);
      await expect(page.locator('.player__selfcam')).toBeVisible();

      // Playing the master carries the auxiliaries with it, and they stay together.
      await page.locator('.player__play').click();
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.currentTime), {
        timeout: 15_000,
      }).toBeGreaterThan(0.3);

      const spread = await page.evaluate(() => {
        const tab = document.querySelector('.player__video') as HTMLVideoElement;
        const cam = document.querySelector('.player__selfcam') as HTMLVideoElement;
        const mic = document.querySelector('.player audio') as HTMLAudioElement;
        return [Math.abs(cam.currentTime - tab.currentTime), Math.abs(mic.currentTime - tab.currentTime)];
      });
      // Well inside the hard-resync band; this is alignment, not luck.
      for (const delta of spread) expect(delta).toBeLessThan(0.5);

      // The camera track must not double the tab's audio.
      expect(await page.locator('.player__selfcam').evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
    } finally {
      await closeHarness(harness);
    }
  });

  test('drives the player from the keyboard (design f19)', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'off', recordSelfVideo: false,
      });
      await meetPage.waitForTimeout(2_500);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });
      await page.locator('.recording-row__play').first().click();
      const video = page.locator('.player__video');
      await expect.poll(async () => await video.getAttribute('src'), { timeout: 20_000 }).toMatch(/^blob:/);
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 20_000,
      }).toBeGreaterThanOrEqual(1);

      // Space plays, space pauses.
      await page.keyboard.press('Space');
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.paused), {
        timeout: 10_000,
      }).toBe(false);
      await page.keyboard.press('Space');
      await expect.poll(async () => await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);

      // L steps the speed up the ladder; J steps back.
      await page.keyboard.press('l');
      expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1.25);
      await page.keyboard.press('j');
      expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1);

      // M mutes and unmutes.
      await page.keyboard.press('m');
      expect(await video.evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
      await page.keyboard.press('m');
      expect(await video.evaluate((el: HTMLVideoElement) => el.muted)).toBe(false);

      // Escape closes when not in fullscreen.
      await page.keyboard.press('Escape');
      await expect(page.locator('.player')).toHaveCount(0);
    } finally {
      await closeHarness(harness);
    }
  });

  test('lists every file and lets one be switched off reversibly', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'separate', recordSelfVideo: true,
      });
      await meetPage.waitForTimeout(1_800);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });
      await page.locator('.recording-row__play').first().click();
      await expect.poll(async () => await page.locator('.player__video').getAttribute('src'), {
        timeout: 20_000,
      }).toMatch(/^blob:/);

      // The trigger counts what is on.
      await expect(page.locator('.player__files-count')).toHaveText('3');
      await page.locator('.player__files').click();
      const rows = page.locator('.player__file');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).locator('.player__file-label')).toHaveText('Tab video');
      await expect(rows.nth(1).locator('.player__file-label')).toHaveText('Self camera');
      await expect(rows.nth(2).locator('.player__file-label')).toHaveText('Microphone');

      // Switching the camera off hides it — but the row stays, so it is reversible.
      await rows.nth(1).click();
      await expect(page.locator('.player__selfcam')).toBeHidden();
      await expect(page.locator('.player__files-count')).toHaveText('2');
      await expect(page.locator('.player__file')).toHaveCount(3);
      await expect(page.locator('.player__file').nth(1)).toHaveAttribute('aria-checked', 'false');

      await page.locator('.player__file').nth(1).click();
      await expect(page.locator('.player__selfcam')).toBeVisible();
      await expect(page.locator('.player__files-count')).toHaveText('3');

      // One fader per audio track; the camera gets none.
      await page.locator('.player__files').click();
      await page.locator('.player__icon--on-picture').first().click();
      await expect(page.locator('.player__fader')).toHaveCount(2);

      // Clicking a track name mutes that track only.
      await page.locator('.player__fader-name').nth(1).click();
      await expect(page.locator('.player__fader-name').nth(1)).toHaveClass(/player__fader-name--muted/);
      expect(await page.locator('.player audio').evaluate((el: HTMLAudioElement) => el.muted)).toBe(true);
      expect(await page.locator('.player__video').evaluate((el: HTMLVideoElement) => el.muted)).toBe(false);
    } finally {
      await closeHarness(harness);
    }
  });
});

