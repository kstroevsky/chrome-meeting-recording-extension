import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const repoRoot = process.cwd();
const extensionPath = path.resolve(repoRoot, 'dist');
const meetUrl = process.env.MEET_URL ?? 'https://meet.google.com/xsm-hmvk-jno';
const guestName = process.env.MEET_NAME ?? 'Codex Test';
const outputDir = path.resolve(repoRoot, process.env.OUTPUT_DIR ?? 'output/playwright/downloads');
const artifactsDir = path.resolve(repoRoot, process.env.ARTIFACTS_DIR ?? 'output/playwright/artifacts');
const userDataDirPrefix = path.join(os.tmpdir(), 'codex-real-meet-');
const tabPreset = process.env.TAB_PRESET ?? '640x360';
const tabMaxFrameRate = process.env.TAB_MAX_FRAME_RATE ?? '24';
const tabResizePostprocess = process.env.TAB_RESIZE_POSTPROCESS === '1';
const tabMp4Output = process.env.TAB_MP4_OUTPUT === '1';
const recordSelfVideo = process.env.RECORD_SELF_VIDEO === '1';
const selfVideoPreset = process.env.SELF_VIDEO_PRESET ?? '1920x1080';
const selfVideoMp4Output = process.env.SELF_VIDEO_MP4_OUTPUT === '1';
const recordingMode = process.env.RECORDING_MODE ?? 'opfs';
const recordSeconds = Number(process.env.RECORD_SECONDS ?? '8');
const joinTimeoutMs = Number(process.env.JOIN_TIMEOUT_MS ?? '180000');
const headless = process.env.PW_HEADLESS === '1';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function latestMatchingFile(dir, prefix, extensions = ['.webm', '.mp4']) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const matches = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || !extensions.some((extension) => entry.name.endsWith(extension))) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.stat(fullPath);
    matches.push({ fullPath, mtimeMs: stat.mtimeMs });
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.fullPath ?? null;
}

async function waitForFile(dir, prefix, options = {}) {
  const {
    timeoutMs = 120000,
    extensions = ['.webm', '.mp4'],
  } = options;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = await latestMatchingFile(dir, prefix, extensions);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${prefix}*{${extensions.join(',')}} in ${dir}`);
}

async function ffprobe(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,codec_name,bit_rate',
    '-of',
    'default=noprint_wrappers=1',
    filePath,
  ]);
  return stdout.trim();
}

async function captureArtifacts(page, label) {
  await ensureDir(artifactsDir);
  const slug = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`;
  const screenshotPath = path.join(artifactsDir, `${slug}.png`);
  const statePath = path.join(artifactsDir, `${slug}.json`);

  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 10_000),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
      text: (button.innerText || button.getAttribute('aria-label') || '').trim(),
      ariaLabel: button.getAttribute('aria-label'),
      disabled: button.hasAttribute('disabled'),
    })),
    inputs: Array.from(document.querySelectorAll('input, textarea')).map((input) => ({
      tag: input.tagName,
      type: input.getAttribute('type'),
      ariaLabel: input.getAttribute('aria-label'),
      placeholder: input.getAttribute('placeholder'),
      name: input.getAttribute('name'),
    })),
  }));

  await Promise.all([
    page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {}),
    fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`).catch(() => {}),
  ]);

  return { screenshotPath, statePath };
}

async function maybeClick(locator) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.click();
    return true;
  }
  return false;
}

async function sendRuntimeMessage(page, payload) {
  return await page.evaluate(
    (message) =>
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError?.message;
          if (error) {
            reject(new Error(error));
            return;
          }
          resolve(response);
        });
      }),
    payload
  );
}

async function findMeetTabId(page) {
  return await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const meetTabs = tabs.filter(
      (tab) => typeof tab.id === 'number' && typeof tab.url === 'string' && tab.url.startsWith('https://meet.google.com/')
    );
    return (meetTabs.find((tab) => tab.active) ?? meetTabs[0])?.id ?? null;
  });
}

async function resetTranscript(page, tabId) {
  await page.evaluate(
    (targetTabId) =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(targetTabId, { type: 'RESET_TRANSCRIPT' }, () => {
          resolve(chrome.runtime.lastError?.message ?? null);
        });
      }),
    tabId
  );
}

async function pollSession(page, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await sendRuntimeMessage(page, { type: 'GET_RECORDING_STATUS' });
    const session = response?.session;
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function startRecording(page, tabId) {
  await resetTranscript(page, tabId);
  const response = await sendRuntimeMessage(page, {
    type: 'START_RECORDING',
    tabId,
    runConfig: {
      storageMode: 'local',
      micMode: 'off',
      recordSelfVideo,
    },
  });

  if (response?.ok === false) {
    throw new Error(response.error || 'Failed to start recording');
  }

  return await pollSession(page, (session) => session?.phase === 'recording', 30_000, 'recording phase');
}

async function stopRecording(page) {
  const response = await sendRuntimeMessage(page, { type: 'STOP_RECORDING' });
  if (response?.ok === false) {
    throw new Error(response.error || 'Failed to stop recording');
  }

  return await pollSession(page, (session) => session?.phase === 'idle', 120_000, 'idle phase after stop');
}

async function waitForExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  }
  const url = serviceWorker.url();
  const match = url.match(/^chrome-extension:\/\/([a-z]{32})\//);
  if (!match) throw new Error(`Could not derive extension id from ${url}`);
  return match[1];
}

async function joinMeet(page) {
  console.log(`Opening Meet guest flow: ${meetUrl}`);
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded' });

  const continueWithoutMedia = page.getByRole('button', { name: /Continue without microphone and camera/i });
  if (await maybeClick(continueWithoutMedia)) {
    await maybeClick(page.getByRole('button', { name: /^Got it$/i }));
  }

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);

  const pageText = await page.locator('body').innerText().catch(() => '');
  if (/You can't join this video call|This meeting has ended/i.test(pageText)) {
    const { screenshotPath, statePath } = await captureArtifacts(page, 'meet-unavailable');
    throw new Error(
      `Meet rejected the join flow before pre-join. Screenshot: ${screenshotPath}. State dump: ${statePath}`
    );
  }

  const gotIt = page.getByRole('button', { name: /^Got it$/i });
  await maybeClick(gotIt);

  const nameField = page.getByRole('textbox', { name: /Your name/i });
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill(guestName);
  }

  const askToJoin = page.getByRole('button', { name: /Ask to join/i });
  const joinNow = page.getByRole('button', { name: /^Join now$/i });
  if (await maybeClick(askToJoin)) {
    console.log('Clicked Ask to join. Waiting for host admission...');
    await page.waitForFunction(
      () => !document.body.innerText.includes('Please wait until a meeting host brings you into the call'),
      undefined,
      { timeout: joinTimeoutMs }
    );
  } else if (await maybeClick(joinNow)) {
    console.log('Clicked Join now.');
  } else {
    const { screenshotPath, statePath } = await captureArtifacts(page, 'meet-prejoin-unknown');
    throw new Error(`Could not find Ask to join / Join now. Screenshot: ${screenshotPath}. State dump: ${statePath}`);
  }

  await page.waitForTimeout(5000);
  const postJoinText = await page.locator('body').innerText().catch(() => '');
  if (/You can't join this video call|This meeting has ended/i.test(postJoinText)) {
    const { screenshotPath, statePath } = await captureArtifacts(page, 'meet-postjoin-denied');
    throw new Error(`Meet denied admission. Screenshot: ${screenshotPath}. State dump: ${statePath}`);
  }

  console.log('Meet join flow completed.');
}

async function main() {
  await ensureDir(outputDir);
  await ensureDir(artifactsDir);
  const userDataDir = await fs.mkdtemp(userDataDirPrefix);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: 'chromium',
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--use-fake-ui-for-media-stream',
    ],
  });

  try {
    const extensionId = await waitForExtensionId(context);
    console.log(`Loaded extension ${extensionId}`);
    await context.grantPermissions(['camera', 'microphone'], {
      origin: `chrome-extension://${extensionId}`,
    }).catch(() => {});

    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/settings.html`, {
      waitUntil: 'domcontentloaded',
    });
    await settingsPage.selectOption('#recording-mode', recordingMode);
    await settingsPage.selectOption('#mic-mode', 'off');
    await settingsPage.setChecked('#separate-camera', recordSelfVideo);
    await settingsPage.selectOption('#self-video-resolution-preset', selfVideoPreset);
    await settingsPage.selectOption('#tab-resolution-preset', tabPreset);
    await settingsPage.fill('#tab-max-frame-rate', tabMaxFrameRate);
    await settingsPage.setChecked('#tab-resize-postprocess', tabResizePostprocess);
    await settingsPage.setChecked('#tab-mp4-output', tabMp4Output);
    await settingsPage.setChecked('#self-video-mp4-output', selfVideoMp4Output);
    await settingsPage.click('#save-settings');

    console.log('Recorder settings for validation:', {
      recordingMode,
      tabPreset,
      tabMaxFrameRate,
      tabResizePostprocess,
      tabMp4Output,
      recordSelfVideo,
      selfVideoPreset,
      selfVideoMp4Output,
    });

    const meetPage = await context.newPage();
    await joinMeet(meetPage);

    const meetTabId = await findMeetTabId(settingsPage);
    if (typeof meetTabId !== 'number') {
      throw new Error('Could not resolve Google Meet tab id for recording');
    }

    const startSession = await startRecording(settingsPage, meetTabId);
    if (Array.isArray(startSession?.warnings) && startSession.warnings.length > 0) {
      console.log('Warnings after start:');
      for (const warning of startSession.warnings) {
        console.log(`- ${warning}`);
      }
    }

    console.log(`Recording for ${recordSeconds}s...`);
    await new Promise((resolve) => setTimeout(resolve, recordSeconds * 1000));

    const finalSession = await stopRecording(settingsPage);
    if (Array.isArray(finalSession?.warnings) && finalSession.warnings.length > 0) {
      console.log('Warnings after stop:');
      for (const warning of finalSession.warnings) {
        console.log(`- ${warning}`);
      }
    }

    const tabFile = await waitForFile(outputDir, 'google-meet-recording-');
    console.log(`Tab file: ${tabFile}`);
    console.log(await ffprobe(tabFile));

    if (recordSelfVideo) {
      const cameraFile = await waitForFile(outputDir, 'google-meet-self-video-');
      console.log(`Camera file: ${cameraFile}`);
      console.log(await ffprobe(cameraFile));
    }
  } finally {
    await context.close().catch(() => {});
    await removeDir(userDataDir).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
