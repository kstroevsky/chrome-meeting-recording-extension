import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const extensionPath = path.join(repoRoot, process.env.EXTENSION_PATH ?? 'dist-e2e');
const mockMeetFixturePath = path.join(repoRoot, 'tests/fixtures/mock-meet.html');
const mockMeetUrl = 'https://meet.google.com/abc-defg-hij';

type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'failed';

type RecordingSessionSnapshot = {
  phase: RecordingPhase;
  error?: string;
};

type CommandResult =
  | { ok: true; session: RecordingSessionSnapshot }
  | { ok: false; error: string; session: RecordingSessionSnapshot };

type TranscriptResponse = {
  transcript: string;
  provider: {
    providerId: string;
    meetingId: string | null;
    supportsCaptions: boolean;
  };
};

type ExtensionHarness = {
  context: BrowserContext;
  controlPage: Page;
  extensionId: string;
  userDataDir: string;
  downloadsDir: string;
};

async function launchExtensionHarness(testOutputPath: (pathSegments: string) => string): Promise<ExtensionHarness> {
  const mockMeetHtml = await fs.readFile(mockMeetFixturePath, 'utf8');
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-recorder-e2e-'));
  const downloadsDir = testOutputPath('downloads');
  await fs.mkdir(downloadsDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.PW_HEADLESS !== '0',
    channel: 'chromium',
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });

  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: mockMeetHtml,
    })
  );

  const extensionId = await waitForExtensionId(context);
  await context.grantPermissions(['camera', 'microphone'], {
    origin: `chrome-extension://${extensionId}`,
  }).catch(() => {});

  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/settings.html`, {
    waitUntil: 'domcontentloaded',
  });

  return { context, controlPage, extensionId, userDataDir, downloadsDir };
}

async function closeHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close().catch(() => {});
  await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => {});
}

async function waitForExtensionId(context: BrowserContext): Promise<string> {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }

  const match = serviceWorker.url().match(/^chrome-extension:\/\/([a-z]{32})\//);
  if (!match) throw new Error(`Could not resolve extension id from ${serviceWorker.url()}`);
  return match[1];
}

async function openMockMeetPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(mockMeetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div[role="region"][aria-label="Captions"] .ygicle');
  return page;
}

async function findMockMeetTabId(controlPage: Page): Promise<number> {
  const tabId = await controlPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    return tabs.find((tab) => tab.url?.startsWith('https://meet.google.com/'))?.id ?? null;
  });

  if (typeof tabId !== 'number') throw new Error('Could not find mocked Meet tab id');
  return tabId;
}

async function sendRuntimeMessage<T>(controlPage: Page, message: unknown): Promise<T> {
  return await controlPage.evaluate((payload) => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError?.message;
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(response);
      });
    });
  }, message) as T;
}

async function sendTabMessage<T>(controlPage: Page, tabId: number, message: unknown): Promise<T> {
  return await controlPage.evaluate(({ targetTabId, payload }) => {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(targetTabId, payload, (response) => {
        const error = chrome.runtime.lastError?.message;
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(response);
      });
    });
  }, { targetTabId: tabId, payload: message }) as T;
}

async function getRecordingSession(controlPage: Page): Promise<RecordingSessionSnapshot> {
  const response = await sendRuntimeMessage<{ session: RecordingSessionSnapshot }>(
    controlPage,
    { type: 'GET_RECORDING_STATUS' }
  );
  return response.session;
}

async function waitForSessionPhase(
  controlPage: Page,
  phase: RecordingPhase,
  timeoutMs = 45_000
): Promise<RecordingSessionSnapshot> {
  const startedAt = Date.now();
  let lastSession: RecordingSessionSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSession = await getRecordingSession(controlPage);
    if (lastSession.phase === phase) return lastSession;
    if (lastSession.phase === 'failed') {
      throw new Error(`Recording failed while waiting for ${phase}: ${lastSession.error ?? 'unknown error'}`);
    }
    await controlPage.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for ${phase}; last phase was ${lastSession?.phase ?? 'unknown'}`);
}

async function saveLocalTabOnlyDefaults(controlPage: Page): Promise<void> {
  await controlPage.selectOption('#recording-mode', 'opfs');
  await controlPage.selectOption('#mic-mode', 'off');
  await controlPage.setChecked('#separate-camera', false);
  await controlPage.selectOption('#tab-resolution-preset', '640x360');
  await controlPage.fill('#tab-max-frame-rate', '24');
  await controlPage.click('#save-settings');
  await expect(controlPage.locator('#status')).toHaveText('Saved');
}

async function assertPopupReflectsSavedDefaults(harness: ExtensionHarness): Promise<void> {
  const popupPage = await harness.context.newPage();
  await popupPage.goto(`chrome-extension://${harness.extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(popupPage.locator('#storage-mode')).toHaveValue('local');
  await expect(popupPage.locator('#mic-mode')).toHaveValue('off');
  await expect(popupPage.locator('#record-self-video')).not.toBeChecked();
  await popupPage.close();
}

async function getDownloads(controlPage: Page): Promise<chrome.downloads.DownloadItem[]> {
  return await controlPage.evaluate(() => {
    return new Promise((resolve, reject) => {
      chrome.downloads.search({}, (items) => {
        const error = chrome.runtime.lastError?.message;
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(items);
      });
    });
  });
}

async function waitForCompletedDownloads(
  controlPage: Page,
  downloadsDir: string,
  expectedCount: number,
  timeoutMs = 45_000
): Promise<chrome.downloads.DownloadItem[]> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const complete = (await getDownloads(controlPage))
      .filter((item) => item.state === 'complete' && item.exists !== false)
      .sort((a, b) => b.startTime.localeCompare(a.startTime));

    if (complete.length >= expectedCount) {
      const selected = complete.slice(0, expectedCount);
      for (const item of selected) {
        expect(item.filename.startsWith(downloadsDir)).toBe(true);
        const stat = await fs.stat(item.filename);
        expect(stat.size).toBeGreaterThan(0);
      }
      return selected;
    }

    await controlPage.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for ${expectedCount} completed download(s)`);
}

async function startRecording(controlPage: Page, tabId: number, runConfig: Record<string, unknown>): Promise<void> {
  const response = await sendRuntimeMessage<CommandResult>(controlPage, {
    type: 'START_RECORDING',
    tabId,
    runConfig,
  });
  if (!response.ok) throw new Error(`START_RECORDING failed: ${response.error}`);
  await waitForSessionPhase(controlPage, 'recording', 30_000);
}

async function stopRecording(controlPage: Page): Promise<void> {
  const response = await sendRuntimeMessage<CommandResult>(controlPage, { type: 'STOP_RECORDING' });
  if (!response.ok) throw new Error(`STOP_RECORDING failed: ${response.error}`);
  await waitForSessionPhase(controlPage, 'idle', 45_000);
}

test.describe('mock Meet extension E2E', () => {
  test('injects into the mocked Meet origin and serves transcript messages', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      const initialTranscript = await sendTabMessage<TranscriptResponse>(
        harness.controlPage,
        meetTabId,
        { type: 'GET_TRANSCRIPT' }
      );
      expect(initialTranscript.provider).toEqual({
        providerId: 'google-meet',
        meetingId: 'abc-defg-hij',
        supportsCaptions: true,
      });
      expect(initialTranscript.transcript).toContain('Alice Example : Initial caption from mocked Meet');

      const meetPage = harness.context.pages().find((page) => page.url().startsWith(mockMeetUrl));
      if (!meetPage) throw new Error('Mock Meet page was not open');
      await meetPage.evaluate(() => (window as any).mockMeet.setCaption('Updated Scenario A caption'));

      await expect.poll(async () => {
        const response = await sendTabMessage<TranscriptResponse>(
          harness.controlPage,
          meetTabId,
          { type: 'GET_TRANSCRIPT' }
        );
        return response.transcript;
      }).toContain('Alice Example : Updated Scenario A caption');

      const resetResponse = await sendTabMessage<{ ok: true }>(
        harness.controlPage,
        meetTabId,
        { type: 'RESET_TRANSCRIPT' }
      );
      expect(resetResponse).toEqual({ ok: true });

      const afterReset = await sendTabMessage<TranscriptResponse>(
        harness.controlPage,
        meetTabId,
        { type: 'GET_TRANSCRIPT' }
      );
      expect(afterReset.transcript.trim()).toBe('');
    } finally {
      await closeHarness(harness);
    }
  });

  test('persists local defaults, records the mocked Meet tab, and auto-stops on ended DOM', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveLocalTabOnlyDefaults(harness.controlPage);
      await assertPopupReflectsSavedDefaults(harness);

      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });

      await meetPage.waitForTimeout(2_000);
      await meetPage.evaluate(() => (window as any).mockMeet.endMeeting());
      await waitForSessionPhase(harness.controlPage, 'idle', 75_000);

      const downloads = await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        1,
        45_000
      );
      expect(downloads).toHaveLength(1);
    } finally {
      await closeHarness(harness);
    }
  });

  test('records separate microphone and self-video artifacts with fake media devices', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'separate',
        recordSelfVideo: true,
      });

      await harness.controlPage.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      const downloads = await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        3,
        45_000
      );
      expect(downloads).toHaveLength(3);
    } finally {
      await closeHarness(harness);
    }
  });
});
