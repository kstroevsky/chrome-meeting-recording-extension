import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
} from './helpers/extensionHarness';

/**
 * A web page must not be able to instantiate the offscreen runtime. When it
 * could (offscreen.html was web-accessible to <all_urls>), a hidden iframe on
 * any site took over the background's recording Port: the user's stop failed
 * with a stale-epoch error while the real recorder kept capturing.
 */
test('a hostile page cannot load the offscreen runtime or break an active recording', async ({}, testInfo) => {
  const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
  try {
    const hostile = `chrome-extension://${harness.extensionId}/offscreen.html`;
    await harness.context.route('https://hostile.example/', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><iframe src="${hostile}"></iframe>`,
    }));

    await saveRecordingSettings(harness.controlPage);
    await openMockMeetPage(harness.context);
    const meetTabId = await findMockMeetTabId(harness.controlPage);
    await startRecording(harness.controlPage, meetTabId, {
      storageMode: 'local',
      micMode: 'off',
      recordSelfVideo: false,
    });

    const page = await harness.context.newPage();
    await page.goto('https://hostile.example/');
    await page.waitForTimeout(3_000);

    expect(page.frames().map((frame) => frame.url()).filter((url) => url.startsWith('chrome-extension://'))).toEqual([]);
    const contexts = await harness.controlPage.evaluate(async () =>
      (await chrome.runtime.getContexts({})).filter((context) => context.documentUrl?.includes('offscreen.html')).length);
    expect(contexts).toBe(1);

    const stopped = await stopRecording(harness.controlPage);
    expect(stopped.phase).toBe('idle');
    await waitForCompletedDownloads(harness.controlPage, harness.downloadsDir, 1);
  } finally {
    await closeHarness(harness);
  }
});
