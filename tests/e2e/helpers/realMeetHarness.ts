import { chromium, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  getDownloads,
  probeHardwareMedia,
  readPerfSnapshot,
  sendRuntimeMessage,
  setPerfSettings,
  stopRecording,
  waitForSessionPhase,
  type ExtensionHarness,
  type HardwareProbeResult,
} from './extensionHarness';

export type MeetMediaMode = 'on' | 'off';
export type RealMeetBrowserChannel = 'chrome' | 'chrome-for-testing';

export type MeetMediaState = {
  microphone: 'on' | 'off' | 'unknown';
  camera: 'on' | 'off' | 'unknown';
  leaveCallVisible: boolean;
};

export type RealMeetHarness = ExtensionHarness & {
  meetPage: Page;
  debugPage: Page;
  meetUrl: string;
  guestName: string;
  meetMedia: MeetMediaMode;
  browserChannel: RealMeetBrowserChannel;
  accountMode: 'signed-in' | 'anonymous';
  tracePath: string;
  preserveUserDataDir: boolean;
};

export type RealMeetHardwareState = {
  preflight: HardwareProbeResult;
  concurrentWithMeet: HardwareProbeResult;
};

function extensionIdFromKey(base64Key: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(base64Key, 'base64'))
    .digest();
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += String.fromCharCode(97 + (digest[index] >> 4));
    id += String.fromCharCode(97 + (digest[index] & 0x0f));
  }
  return id;
}

const execFileAsync = promisify(execFile);

async function invokeChromeActionWithNativeInput(
  browserChannel: RealMeetBrowserChannel
): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      const applicationName = browserChannel === 'chrome'
        ? 'Google Chrome'
        : 'Google Chrome for Testing';
      await execFileAsync('/usr/bin/osascript', [
        '-e', `tell application "${applicationName}" to activate`,
        '-e', 'delay 0.2',
        '-e', 'tell application "System Events" to key code 25 using {control down, shift down}',
        '-e', 'delay 0.5',
        '-e', 'tell application "System Events" to repeat 7 times',
        '-e', 'key code 48',
        '-e', 'end repeat',
        '-e', 'tell application "System Events" to key code 36',
      ]);
      return;
    }

    if (process.platform === 'win32') {
      const windowName = browserChannel === 'chrome'
        ? 'Google Chrome'
        : 'Google Chrome for Testing';
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `$shell = New-Object -ComObject WScript.Shell; `
          + `$null = $shell.AppActivate('${windowName}'); `
          + 'Start-Sleep -Milliseconds 200; '
          + `$shell.SendKeys('^+9'); `
          + 'Start-Sleep -Milliseconds 500; '
          + `$shell.SendKeys('{TAB 7}{ENTER}')`,
      ]);
      return;
    }

    if (process.platform === 'linux') {
      await execFileAsync('xdotool', [
        'key',
        '--clearmodifiers',
        'ctrl+shift+9',
        'sleep',
        '0.5',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Tab',
        'key',
        'Return',
      ]);
      return;
    }

    throw new Error(`unsupported platform ${process.platform}`);
  } catch (error) {
    const processError = error as Error & { stderr?: string };
    const detail = [
      processError.message || String(error),
      processError.stderr?.trim(),
    ].filter(Boolean).join('\n');
    throw new Error(
      `Could not invoke the Chrome extension action through native input: ${detail}. `
      + 'On macOS, grant Accessibility permission to the terminal or Codex app running '
      + 'the test. On Linux, install xdotool. Windows uses PowerShell SendKeys.'
    );
  }
}

async function resolveExtensionId(
  context: BrowserContext,
  extensionPath: string
): Promise<string> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8')
  ) as { key?: string };
  if (manifest.key) return extensionIdFromKey(manifest.key);

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }
  const match = serviceWorker.url().match(/^chrome-extension:\/\/([a-z]{32})\//);
  if (!match) throw new Error(`Could not resolve extension id from ${serviceWorker.url()}`);
  return match[1];
}

async function openExtensionControlPage(
  context: BrowserContext,
  extensionId: string,
  extensionPath: string,
  browserChannel: RealMeetBrowserChannel
): Promise<Page> {
  const controlUrl = `chrome-extension://${extensionId}/settings.html`;
  let controlPage = await context.newPage();
  try {
    await controlPage.goto(controlUrl, { waitUntil: 'domcontentloaded' });
    await controlPage.waitForSelector('#save-settings', { timeout: 15_000 });
    return controlPage;
  } catch (error) {
    if (browserChannel !== 'chrome') throw error;
  }

  await controlPage.close().catch(() => {});
  controlPage = await context.newPage();
  await controlPage.goto('chrome://extensions');
  const developerMode = controlPage.locator(
    'extensions-manager extensions-toolbar #devMode'
  );
  await developerMode.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await developerMode.getAttribute('aria-pressed')) !== 'true') {
    await developerMode.click();
  }
  const loadUnpacked = controlPage.locator(
    'extensions-manager extensions-toolbar #loadUnpacked'
  );
  await loadUnpacked.click();
  console.log('');
  console.log('============================================================');
  console.log('ONE-TIME STABLE CHROME EXTENSION SETUP');
  console.log(`SELECT THIS FOLDER: ${extensionPath}`);
  console.log('Then click Select in the macOS folder picker.');
  console.log('============================================================');
  console.log('');

  const setupDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < setupDeadline) {
    const candidate = await context.newPage().catch(() => null);
    if (candidate) {
      try {
        await candidate.goto(controlUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 5_000,
        });
        await candidate.waitForSelector('#save-settings', { timeout: 5_000 });
        await controlPage.close().catch(() => {});
        return candidate;
      } catch {
        await candidate.close().catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for stable Chrome to load the extension from ${extensionPath}`
  );
}

async function ensureExtensionActionShortcut(
  context: BrowserContext,
  controlPage: Page,
  extensionPath: string
): Promise<string> {
  const readShortcut = () => controlPage.evaluate(async () => {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === '_execute_action')
      ?.shortcut ?? '';
  });
  const existingShortcut = await readShortcut();
  if (existingShortcut) return existingShortcut;

  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8')
  ) as { name: string };
  const shortcutsPage = await context.newPage();
  try {
    await shortcutsPage.goto('chrome://extensions/shortcuts');
    const shortcutInput = shortcutsPage.locator(
      `cr-shortcut-input[input-aria-label*="${manifest.name}"]`
    );
    await shortcutInput.waitFor({ state: 'visible', timeout: 15_000 });
    await shortcutInput.locator('#edit').click();
    await shortcutsPage.keyboard.press('Control+Shift+9');
    await shortcutsPage.waitForTimeout(500);
  } finally {
    await shortcutsPage.close().catch(() => {});
  }

  const assignedShortcut = await readShortcut();
  if (!assignedShortcut) {
    throw new Error(
      'Chrome did not bind the extension action shortcut. Open '
      + 'chrome://extensions/shortcuts and assign Control+Shift+9 to '
      + `"Activate the extension" for ${manifest.name}.`
    );
  }
  return assignedShortcut;
}

async function maybeClick(locator: ReturnType<Page['getByRole']>): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click();
  return true;
}

async function configurePrejoinMedia(
  page: Page,
  mode: MeetMediaMode
): Promise<void> {
  await maybeClick(page.getByRole('button', { name: /^Got it$/i }));
  const microphoneAction = mode === 'on' ? /Turn on microphone/i : /Turn off microphone/i;
  const cameraAction = mode === 'on' ? /Turn on camera/i : /Turn off camera/i;
  await maybeClick(page.getByRole('button', { name: microphoneAction }));
  await maybeClick(page.getByRole('button', { name: cameraAction }));
}

export async function captureMeetDiagnostics(
  page: Page,
  outputPath: (name: string) => string,
  label: string
): Promise<{ screenshotPath: string; statePath: string }> {
  const screenshotPath = outputPath(`${label}.png`);
  const statePath = outputPath(`${label}.json`);
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 15_000),
    buttons: Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((button) => ({
        text: (
          (button as HTMLElement).innerText
          || button.getAttribute('aria-label')
          || ''
        ).trim().slice(0, 160),
        ariaLabel: button.getAttribute('aria-label'),
        disabled: button.hasAttribute('disabled'),
      }))
      .filter((button) => button.text || button.ariaLabel),
    inputs: Array.from(document.querySelectorAll('input, textarea')).map((input) => ({
      type: input.getAttribute('type'),
      ariaLabel: input.getAttribute('aria-label'),
      placeholder: input.getAttribute('placeholder'),
      name: input.getAttribute('name'),
    })),
  }));
  await Promise.all([
    page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {}),
    fs.writeFile(statePath, JSON.stringify(state, null, 2)),
  ]);
  return { screenshotPath, statePath };
}

export async function readMeetMediaState(page: Page): Promise<MeetMediaState> {
  await page.mouse.move(640, 720).catch(() => {});
  await page.waitForTimeout(300);
  const visible = async (pattern: RegExp) =>
    page.getByRole('button', { name: pattern }).isVisible().catch(() => false);
  const micOffAction = await visible(/Turn off microphone/i);
  const micOnAction = await visible(/Turn on microphone/i);
  const cameraOffAction = await visible(/Turn off camera/i);
  const cameraOnAction = await visible(/Turn on camera/i);
  return {
    microphone: micOffAction ? 'on' : micOnAction ? 'off' : 'unknown',
    camera: cameraOffAction ? 'on' : cameraOnAction ? 'off' : 'unknown',
    leaveCallVisible: await visible(/Leave call/i),
  };
}

export function assertMeetMediaState(
  state: MeetMediaState,
  expectedMode: MeetMediaMode
): void {
  if (!state.leaveCallVisible) throw new Error('Google Meet is no longer in the active call');
  if (state.microphone !== expectedMode) {
    throw new Error(
      `Google Meet microphone expected ${expectedMode}, observed ${state.microphone}`
    );
  }
  if (state.camera !== expectedMode) {
    throw new Error(
      `Google Meet camera expected ${expectedMode}, observed ${state.camera}`
    );
  }
}

async function joinMeet(
  page: Page,
  options: {
    meetUrl: string;
    guestName: string;
    meetMedia: MeetMediaMode;
    joinTimeoutMs: number;
    outputPath: (name: string) => string;
  }
): Promise<'signed-in' | 'anonymous'> {
  const expectedMeetUrl = new URL(options.meetUrl);
  const remainsOnMeetingPage = (): boolean => {
    const current = new URL(page.url());
    return (
      current.hostname === expectedMeetUrl.hostname
      && current.pathname.replace(/\/$/, '') === expectedMeetUrl.pathname.replace(/\/$/, '')
    );
  };

  console.log(`Opening Google Meet: ${options.meetUrl}`);
  await page.goto(options.meetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  const initialText = await page.locator('body').innerText().catch(() => '');
  if (/You can't join this video call|This meeting has ended/i.test(initialText)) {
    const evidence = await captureMeetDiagnostics(
      page,
      options.outputPath,
      'meet-unavailable'
    );
    throw new Error(
      `Google Meet is unavailable. Screenshot: ${evidence.screenshotPath}; DOM: ${evidence.statePath}`
    );
  }

  await configurePrejoinMedia(page, options.meetMedia);

  const nameField = page.getByRole('textbox', { name: /name/i }).first();
  const anonymous = await nameField.isVisible().catch(() => false);
  if (anonymous) {
    await nameField.click();
    await nameField.fill(options.guestName);
    await page.waitForTimeout(500);
  } else {
    console.log('Using the Google account stored in the persistent Chrome profile.');
  }

  const joinNow = page.getByRole('button', { name: /^Join now$/i });
  const askToJoin = page.getByRole('button', { name: /Ask to join/i });
  const switchHere = page.getByRole('button', { name: /^Switch here$/i });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('button')).some((candidate) =>
        /^(Join now|Ask to join|Switch here)$/i.test(
          (
            candidate.textContent
            || candidate.getAttribute('aria-label')
            || ''
          ).trim()
        )
        && !candidate.hasAttribute('disabled')
      ),
    undefined,
    { timeout: 30_000 }
  );
  if (await joinNow.isVisible().catch(() => false)) {
    await joinNow.click();
    console.log('Joined the meeting directly.');
  } else if (await switchHere.isVisible().catch(() => false)) {
    await switchHere.click();
    console.log('Transferred the signed-in meeting session to the test browser.');
  } else {
    await askToJoin.click();
    console.log('');
    console.log('============================================================');
    console.log(
      anonymous
        ? `ADMIT THIS GUEST NOW: ${options.guestName}`
        : 'ADMIT THE SIGNED-IN REAL-MEET TEST ACCOUNT NOW'
    );
    console.log(`MEETING: ${options.meetUrl}`);
    console.log('============================================================');
    console.log('');
  }

  const deadline = Date.now() + options.joinTimeoutMs;
  const failureGraceDeadline = Date.now() + Number(
    process.env.ADMISSION_FAILURE_GRACE_MS ?? '60000'
  );
  let terminalStateLogged = false;
  while (Date.now() < deadline) {
    if (
      await page
        .getByRole('button', { name: /Leave call/i })
        .isVisible()
        .catch(() => false)
    ) {
      await page.waitForTimeout(2_000);
      return anonymous ? 'anonymous' : 'signed-in';
    }
    if (!remainsOnMeetingPage()) {
      const evidence = await captureMeetDiagnostics(
        page,
        options.outputPath,
        'admission-redirected'
      );
      throw new Error(
        `Google Meet rejected or ended the admission request and redirected to ${page.url()}. Screenshot: ${evidence.screenshotPath}; DOM: ${evidence.statePath}`
      );
    }
    const body = await page.locator('body').innerText().catch(() => '');
    if (
      /Nobody responded|was denied|can't join this video call|meeting has ended|removed from the meeting/i.test(
        body
      )
    ) {
      if (Date.now() < failureGraceDeadline) {
        if (!terminalStateLogged) {
          console.log(
            'Google displayed a rejection state; keeping the browser open for the admission grace period.'
          );
          terminalStateLogged = true;
        }
        await page.waitForTimeout(2_000);
        continue;
      }
      const evidence = await captureMeetDiagnostics(
        page,
        options.outputPath,
        'admission-failed'
      );
      throw new Error(
        `Google Meet rejected the participant. Ensure the organizer is already in the call and the account is invited or allowed to request admission. Screenshot: ${evidence.screenshotPath}; DOM: ${evidence.statePath}`
      );
    }
    await page.waitForTimeout(2_000);
  }

  const evidence = await captureMeetDiagnostics(
    page,
    options.outputPath,
    'admission-timeout'
  );
  throw new Error(
    `Timed out waiting for host admission. Screenshot: ${evidence.screenshotPath}; DOM: ${evidence.statePath}`
  );
}

export async function launchRealMeetHarness(
  testInfo: TestInfo,
  options: {
    meetUrl: string;
    guestName: string;
    meetMedia: MeetMediaMode;
    browserChannel: RealMeetBrowserChannel;
    joinTimeoutMs: number;
  }
): Promise<{ harness: RealMeetHarness; hardware: RealMeetHardwareState }> {
  const preserveUserDataDir = options.browserChannel === 'chrome';
  const userDataDir = preserveUserDataDir
    ? path.resolve(
      process.env.REAL_MEET_CHROME_PROFILE
        ?? 'output/real-meet/stable-chrome-profile'
    )
    : await fs.mkdtemp(path.join(os.tmpdir(), 'real-meet-e2e-'));
  const downloadsDir = testInfo.outputPath('downloads');
  const extensionPath = path.resolve(process.cwd(), 'dist');
  const tracePath = testInfo.outputPath('real-meet-trace.zip');
  await Promise.all([
    fs.mkdir(downloadsDir, { recursive: true }),
    fs.mkdir(userDataDir, { recursive: true }),
  ]);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: options.browserChannel === 'chrome' ? 'chrome' : 'chromium',
    ignoreDefaultArgs: [
      '--enable-automation',
      ...(options.browserChannel === 'chrome' ? ['--disable-extensions'] : []),
    ],
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: { width: 1280, height: 800 },
    args: [
      ...(options.browserChannel === 'chrome'
        ? []
        : [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ]),
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--enable-precise-memory-info',
    ],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  try {
    const extensionId = await resolveExtensionId(context, extensionPath);
    await Promise.all([
      context
        .grantPermissions(['camera', 'microphone'], {
          origin: `chrome-extension://${extensionId}`,
        })
        .catch(() => {}),
      context
        .grantPermissions(['camera', 'microphone'], {
          origin: new URL(options.meetUrl).origin,
        })
        .catch(() => {}),
    ]);

    const controlPage = await openExtensionControlPage(
      context,
      extensionId,
      extensionPath,
      options.browserChannel
    );
    const actionShortcut = await ensureExtensionActionShortcut(
      context,
      controlPage,
      extensionPath
    );
    console.log(`Extension action shortcut ready: ${actionShortcut}`);
    await setPerfSettings(controlPage, {
      adaptiveSelfVideoProfile: false,
      extendedTimeslice: false,
      debugMode: true,
    });
    const debugPage = await context.newPage();
    await debugPage.goto(`chrome-extension://${extensionId}/debug.html`, {
      waitUntil: 'domcontentloaded',
    });

    const preflightHarness: ExtensionHarness = {
      context,
      controlPage,
      extensionId,
      userDataDir,
      downloadsDir,
      extensionPath,
      deviceMode: 'hardware',
    };
    const initialHardware = await probeHardwareMedia(preflightHarness);
    const preflightPath = testInfo.outputPath('hardware-preflight.json');
    await fs.writeFile(preflightPath, JSON.stringify(initialHardware, null, 2));
    await testInfo.attach('hardware-preflight', {
      path: preflightPath,
      contentType: 'application/json',
    });
    if (!initialHardware.ok) {
      throw new Error(
        `Real camera/microphone preflight failed: ${initialHardware.error ?? 'missing tracks'}`
      );
    }

    const meetPage = await context.newPage();
    const accountMode = await joinMeet(meetPage, {
      ...options,
      outputPath: (name) => testInfo.outputPath(name),
    });
    const initialMeetState = await readMeetMediaState(meetPage);
    assertMeetMediaState(initialMeetState, options.meetMedia);
    console.log(
      'Google Meet is fully active: Leave call, microphone, and camera controls are available.'
    );

    const concurrentHardware = await probeHardwareMedia(preflightHarness);
    const concurrentPath = testInfo.outputPath('hardware-concurrent-with-meet.json');
    await fs.writeFile(concurrentPath, JSON.stringify(concurrentHardware, null, 2));
    await testInfo.attach('hardware-concurrent-with-meet', {
      path: concurrentPath,
      contentType: 'application/json',
    });
    if (!concurrentHardware.ok) {
      throw new Error(
        `Extension could not reacquire camera/microphone while Meet was active: ${
          concurrentHardware.error ?? 'missing tracks'
        }`
      );
    }

    return {
      harness: {
        ...preflightHarness,
        meetPage,
        debugPage,
        meetUrl: options.meetUrl,
        guestName: options.guestName,
        meetMedia: options.meetMedia,
        browserChannel: options.browserChannel,
        accountMode,
        tracePath,
        preserveUserDataDir,
      },
      hardware: {
        preflight: initialHardware,
        concurrentWithMeet: concurrentHardware,
      },
    };
  } catch (error) {
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await testInfo.attach('real-meet-setup-trace', {
      path: tracePath,
      contentType: 'application/zip',
    }).catch(() => {});
    await context.close().catch(() => {});
    if (!preserveUserDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function resetRealMeetDiagnostics(
  controlPage: Page
): Promise<void> {
  await setPerfSettings(controlPage, { debugMode: false });
  await controlPage.waitForTimeout(250);
  await setPerfSettings(controlPage, { debugMode: true });
  await controlPage.waitForTimeout(500);
}

export async function findRealMeetTabId(controlPage: Page): Promise<number> {
  const tabId = await controlPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    const meetTabs = tabs.filter((tab) => typeof tab.id === 'number');
    return (meetTabs.find((tab) => tab.active) ?? meetTabs[0])?.id ?? null;
  });
  if (typeof tabId !== 'number') throw new Error('Could not resolve the real Meet tab id');
  return tabId;
}

export async function startRecordingFromExtensionAction(
  harness: RealMeetHarness,
  tabId: number
): Promise<void> {
  await harness.controlPage.evaluate(
    (targetTabId) => chrome.tabs.update(targetTabId, { active: true }),
    tabId
  );
  await harness.meetPage.bringToFront();
  await harness.meetPage.locator('body').click({ position: { x: 8, y: 8 } }).catch(() => {});

  // Keep the action popup open and activate its real Start button so Chrome's
  // user gesture remains valid through getMediaStreamId and offscreen capture.
  await invokeChromeActionWithNativeInput(harness.browserChannel);
  await waitForSessionPhase(harness.controlPage, 'recording', 30_000);
  await harness.meetPage.bringToFront();
}

export async function waitForNewCompletedDownloads(
  controlPage: Page,
  downloadsDir: string,
  existingIds: Set<number>,
  expectedCount: number,
  timeoutMs = 120_000
): Promise<chrome.downloads.DownloadItem[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed = (await getDownloads(controlPage))
      .filter(
        (item) =>
          !existingIds.has(item.id)
          && item.state === 'complete'
          && item.exists !== false
      )
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
    if (completed.length >= expectedCount) {
      const selected = completed.slice(0, expectedCount);
      for (const item of selected) {
        if (!item.filename.startsWith(downloadsDir)) {
          throw new Error(`Download escaped expected output directory: ${item.filename}`);
        }
        const stat = await fs.stat(item.filename);
        if (stat.size <= 0) throw new Error(`Downloaded artifact is empty: ${item.filename}`);
      }
      return selected;
    }
    await controlPage.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${expectedCount} new completed download(s)`);
}

export async function bestEffortStop(harness: RealMeetHarness): Promise<void> {
  const response = await sendRuntimeMessage<{
    session?: { phase?: string };
  }>(harness.controlPage, { type: 'GET_RECORDING_STATUS' }).catch(() => null);
  const phase = response?.session?.phase;
  if (phase && phase !== 'idle' && phase !== 'failed') {
    await stopRecording(harness.controlPage).catch(() => {});
  }
}

export async function closeRealMeetHarness(
  harness: RealMeetHarness,
  retainTrace: boolean
): Promise<void> {
  await bestEffortStop(harness);
  await harness.meetPage
    .getByRole('button', { name: /Leave call/i })
    .click()
    .catch(() => {});
  await harness.context.tracing.stop({ path: harness.tracePath }).catch(() => {});
  await harness.context.close().catch(() => {});
  if (!harness.preserveUserDataDir) {
    await fs.rm(harness.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!retainTrace) await fs.rm(harness.tracePath, { force: true }).catch(() => {});
}

export async function waitForCurrentPerfSnapshot(
  page: Page,
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readPerfSnapshot(page);
    if (
      snapshot
      && snapshot.summary.lifecycle.stopCompletedCount > 0
      && snapshot.summary.lifecycle.activeTracks === 0
    ) {
      return snapshot;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for finalized real-Meet diagnostics');
}
