import { expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PerfDebugSnapshot, PerfSettings } from '../../../src/shared/perf';
import type { MicMode, RecordingStream } from '../../../src/shared/recording';
import type { ResolutionPreset } from '../../../src/shared/settings';

const repoRoot = process.cwd();
const mockMeetFixturePath = path.join(repoRoot, 'tests/fixtures/mock-meet.html');
export const mockMeetUrl = 'https://meet.google.com/abc-defg-hij';

export type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'failed';

export type RecordingSessionSnapshot = {
  phase: RecordingPhase;
  error?: string;
  warnings?: string[];
};

export type CommandResult =
  | { ok: true; session: RecordingSessionSnapshot }
  | { ok: false; error: string; session: RecordingSessionSnapshot };

export type TranscriptResponse = {
  transcript: string;
  provider: {
    providerId: string;
    meetingId: string | null;
    supportsCaptions: boolean;
  };
};

export type DeviceMode = 'fake' | 'hardware';

export type ExtensionHarness = {
  context: BrowserContext;
  controlPage: Page;
  extensionId: string;
  userDataDir: string;
  downloadsDir: string;
  extensionPath: string;
  deviceMode: DeviceMode;
};

export type HarnessLaunchOptions = {
  extensionPath?: string;
  deviceMode?: DeviceMode;
  headless?: boolean;
  viewport?: { width: number; height: number };
};

export type RecordingSettings = {
  recordingMode?: 'opfs' | 'drive';
  micMode?: MicMode;
  recordSelfVideo?: boolean;
  tabResolution?: ResolutionPreset;
  tabFrameRate?: number;
  selfVideoResolution?: ResolutionPreset;
  selfVideoFrameRate?: number;
  selfVideoBitrate?: number;
  selfVideoMinAdaptiveBitrate?: number;
  chunkDefaultTimesliceMs?: number;
  chunkExtendedTimesliceMs?: number;
};

export type BrowserMetricSnapshot = {
  performance: Record<string, number> | null;
  processCpuTimeSecondsByType: Record<string, number> | null;
  system: {
    modelName?: string;
    modelVersion?: string;
    gpuDevices?: Array<{ vendorString?: string; deviceString?: string }>;
    videoEncoding?: unknown[];
  } | null;
};

export type HardwareProbeResult = {
  ok: boolean;
  error?: string;
  audio?: MediaTrackSettings;
  video?: MediaTrackSettings;
  labels?: string[];
};

export async function launchExtensionHarness(
  testOutputPath: (pathSegments: string) => string,
  options: HarnessLaunchOptions = {}
): Promise<ExtensionHarness> {
  const mockMeetHtml = await fs.readFile(mockMeetFixturePath, 'utf8');
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-recorder-e2e-'));
  const downloadsDir = testOutputPath('downloads');
  const extensionPath = path.resolve(
    repoRoot,
    options.extensionPath ?? process.env.EXTENSION_PATH ?? 'dist-e2e'
  );
  const deviceMode = options.deviceMode ?? 'fake';
  await fs.mkdir(downloadsDir, { recursive: true });

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ];
  if (deviceMode === 'fake') {
    args.push('--use-fake-device-for-media-stream', '--mute-audio');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless ?? process.env.PW_HEADLESS !== '0',
    channel: 'chromium',
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    args,
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

  return {
    context,
    controlPage,
    extensionId,
    userDataDir,
    downloadsDir,
    extensionPath,
    deviceMode,
  };
}

export async function probeHardwareMedia(
  harness: ExtensionHarness
): Promise<HardwareProbeResult> {
  return await harness.controlPage.evaluate(async () => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      const labels = stream.getTracks()
        .map((track) => track.label)
        .filter(Boolean);
      return {
        ok: stream.getAudioTracks().length > 0 && stream.getVideoTracks().length > 0,
        audio: stream.getAudioTracks()[0]?.getSettings?.(),
        video: stream.getVideoTracks()[0]?.getSettings?.(),
        labels,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  });
}

export async function closeHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close().catch(() => {});
  await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => {});
}

export async function waitForExtensionId(context: BrowserContext): Promise<string> {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }

  const match = serviceWorker.url().match(/^chrome-extension:\/\/([a-z]{32})\//);
  if (!match) throw new Error(`Could not resolve extension id from ${serviceWorker.url()}`);
  return match[1];
}

export async function openMockMeetPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(mockMeetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div[role="region"][aria-label="Captions"] .ygicle');
  return page;
}

export async function findMockMeetTabId(controlPage: Page): Promise<number> {
  const tabId = await controlPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    return tabs.find((tab) => tab.url?.startsWith('https://meet.google.com/'))?.id ?? null;
  });

  if (typeof tabId !== 'number') throw new Error('Could not find mocked Meet tab id');
  return tabId;
}

export async function sendRuntimeMessage<T>(controlPage: Page, message: unknown): Promise<T> {
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

export async function sendTabMessage<T>(
  controlPage: Page,
  tabId: number,
  message: unknown
): Promise<T> {
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

export async function getRecordingSession(controlPage: Page): Promise<RecordingSessionSnapshot> {
  const response = await sendRuntimeMessage<{ session: RecordingSessionSnapshot }>(
    controlPage,
    { type: 'GET_RECORDING_STATUS' }
  );
  return response.session;
}

export async function waitForSessionPhase(
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
      throw new Error(
        `Recording failed while waiting for ${phase}: ${lastSession.error ?? 'unknown error'}`
      );
    }
    await controlPage.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for ${phase}; last phase was ${lastSession?.phase ?? 'unknown'}`
  );
}

export async function saveRecordingSettings(
  controlPage: Page,
  settings: RecordingSettings = {}
): Promise<void> {
  await controlPage.selectOption('#recording-mode', settings.recordingMode ?? 'opfs');
  await controlPage.selectOption('#mic-mode', settings.micMode ?? 'off');
  await controlPage.setChecked('#separate-camera', settings.recordSelfVideo ?? false);
  await controlPage.selectOption(
    '#tab-resolution-preset',
    settings.tabResolution ?? '640x360'
  );
  await controlPage.fill(
    '#tab-max-frame-rate',
    String(settings.tabFrameRate ?? 24)
  );
  await controlPage.selectOption(
    '#self-video-resolution-preset',
    settings.selfVideoResolution ?? '640x360'
  );
  await controlPage.fill(
    '#self-video-frame-rate',
    String(settings.selfVideoFrameRate ?? 30)
  );
  if (settings.selfVideoBitrate != null) {
    await controlPage.fill('#self-video-bitrate', String(settings.selfVideoBitrate));
  }
  if (settings.selfVideoMinAdaptiveBitrate != null) {
    await controlPage.fill(
      '#self-video-min-adaptive-bitrate',
      String(settings.selfVideoMinAdaptiveBitrate)
    );
  }
  if (settings.chunkDefaultTimesliceMs != null) {
    await controlPage.fill(
      '#chunk-default-timeslice',
      String(settings.chunkDefaultTimesliceMs)
    );
  }
  if (settings.chunkExtendedTimesliceMs != null) {
    await controlPage.fill(
      '#chunk-extended-timeslice',
      String(settings.chunkExtendedTimesliceMs)
    );
  }
  await controlPage.click('#save-settings');
  await expect(controlPage.locator('#status')).toHaveText('Saved');
}

export async function assertPopupReflectsSavedDefaults(
  harness: ExtensionHarness
): Promise<void> {
  const popupPage = await harness.context.newPage();
  await popupPage.goto(`chrome-extension://${harness.extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(popupPage.locator('#storage-mode')).toHaveValue('local');
  await expect(popupPage.locator('#mic-mode')).toHaveValue('off');
  await expect(popupPage.locator('#record-self-video')).not.toBeChecked();
  await popupPage.close();
}

export async function getDownloads(
  controlPage: Page
): Promise<chrome.downloads.DownloadItem[]> {
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

export async function waitForCompletedDownloads(
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

    await controlPage.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${expectedCount} completed download(s)`);
}

export async function startRecording(
  controlPage: Page,
  tabId: number,
  runConfig: {
    storageMode: 'local' | 'drive';
    micMode: MicMode;
    recordSelfVideo: boolean;
  }
): Promise<void> {
  const response = await sendRuntimeMessage<CommandResult>(controlPage, {
    type: 'START_RECORDING',
    tabId,
    runConfig,
  });
  if (!response.ok) throw new Error(`START_RECORDING failed: ${response.error}`);
  await waitForSessionPhase(controlPage, 'recording', 30_000);
}

export async function stopRecording(controlPage: Page): Promise<RecordingSessionSnapshot> {
  const response = await sendRuntimeMessage<CommandResult>(
    controlPage,
    { type: 'STOP_RECORDING' }
  );
  if (!response.ok) throw new Error(`STOP_RECORDING failed: ${response.error}`);
  return await waitForSessionPhase(controlPage, 'idle', 90_000);
}

export async function openDebugDashboard(harness: ExtensionHarness): Promise<Page> {
  const debugPage = await harness.context.newPage();
  await debugPage.goto(`chrome-extension://${harness.extensionId}/debug.html`, {
    waitUntil: 'domcontentloaded',
  });
  return debugPage;
}

export async function setPerfSettings(
  controlPage: Page,
  settings: Partial<PerfSettings> = {}
): Promise<void> {
  await controlPage.evaluate(async (partial) => {
    await chrome.storage.local.set({
      perfSettings: {
        audioPlaybackBridgeMode: 'always',
        adaptiveSelfVideoProfile: false,
        extendedTimeslice: false,
        dynamicDriveChunkSizing: false,
        parallelUploadConcurrency: 1,
        debugMode: true,
        ...partial,
      },
    });
  }, settings);
}

export async function readPerfSnapshot(controlPage: Page): Promise<PerfDebugSnapshot | null> {
  return await controlPage.evaluate(() => {
    return new Promise((resolve, reject) => {
      chrome.storage.session.get('perfDebugSnapshot', (values) => {
        const error = chrome.runtime.lastError?.message;
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(values.perfDebugSnapshot ?? null);
      });
    });
  }) as PerfDebugSnapshot | null;
}

export async function waitForPerfSnapshot(
  controlPage: Page,
  predicate: (snapshot: PerfDebugSnapshot) => boolean,
  timeoutMs = 20_000
): Promise<PerfDebugSnapshot> {
  const startedAt = Date.now();
  let snapshot: PerfDebugSnapshot | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await readPerfSnapshot(controlPage);
    if (snapshot && predicate(snapshot)) return snapshot;
    await controlPage.waitForTimeout(250);
  }
  throw new Error(
    `Timed out waiting for performance snapshot; last events=${snapshot?.entries.length ?? 0}`
  );
}

export async function collectBrowserMetrics(
  harness: ExtensionHarness,
  page: Page
): Promise<BrowserMetricSnapshot> {
  const result: BrowserMetricSnapshot = {
    performance: null,
    processCpuTimeSecondsByType: null,
    system: null,
  };

  try {
    const pageSession = await harness.context.newCDPSession(page);
    await pageSession.send('Performance.enable');
    const response = await pageSession.send('Performance.getMetrics') as {
      metrics?: Array<{ name: string; value: number }>;
    };
    result.performance = Object.fromEntries(
      (response.metrics ?? []).map((metric) => [metric.name, metric.value])
    );
    await pageSession.detach();
  } catch {}

  try {
    const browser = harness.context.browser();
    if (browser) {
      const session = await browser.newBrowserCDPSession();
      const [processInfo, systemInfo] = await Promise.all([
        session.send('SystemInfo.getProcessInfo') as Promise<{
          processInfo?: Array<{ type: string; cpuTime: number }>;
        }>,
        session.send('SystemInfo.getInfo') as Promise<{
          modelName?: string;
          modelVersion?: string;
          gpu?: {
            devices?: Array<{ vendorString?: string; deviceString?: string }>;
            videoEncoding?: unknown[];
          };
        }>,
      ]);
      result.processCpuTimeSecondsByType = {};
      for (const process of processInfo.processInfo ?? []) {
        result.processCpuTimeSecondsByType[process.type] =
          (result.processCpuTimeSecondsByType[process.type] ?? 0) + process.cpuTime;
      }
      result.system = {
        modelName: systemInfo.modelName,
        modelVersion: systemInfo.modelVersion,
        gpuDevices: systemInfo.gpu?.devices,
        videoEncoding: systemInfo.gpu?.videoEncoding,
      };
      await session.detach();
    }
  } catch {}

  return result;
}

export function expectedStreams(
  micMode: MicMode,
  recordSelfVideo: boolean
): RecordingStream[] {
  const streams: RecordingStream[] = ['tab'];
  if (micMode === 'separate') streams.push('mic');
  if (recordSelfVideo) streams.push('self-video');
  return streams;
}
