import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import {
  hasGoogleAccountSession,
  parseRealMeetProfileCli,
  REAL_MEET_PROFILE_USAGE,
} from './lib/realMeetProfile.mjs';

function extensionIdFromKey(base64Key) {
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  return result.status ?? 1;
}

async function openExtensionPage(context, controlUrl) {
  const page = await context.newPage();
  try {
    await page.goto(controlUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    await page.waitForSelector('#save-settings', { timeout: 5_000 });
    return page;
  } catch {
    await page.close().catch(() => {});
    return null;
  }
}

async function ensureExtensionInstalled(
  context,
  extensionId,
  extensionPath
) {
  const controlUrl = `chrome-extension://${extensionId}/settings.html`;
  const existing = await openExtensionPage(context, controlUrl);
  if (existing) return existing;

  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions');
  const developerMode = extensionsPage.locator(
    'extensions-manager extensions-toolbar #devMode'
  );
  await developerMode.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await developerMode.getAttribute('aria-pressed')) !== 'true') {
    await developerMode.click();
  }
  await extensionsPage
    .locator('extensions-manager extensions-toolbar #loadUnpacked')
    .click();

  console.log('');
  console.log('Select this folder in the native Chrome picker:');
  console.log(extensionPath);
  console.log('');

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const installed = await openExtensionPage(context, controlUrl);
    if (installed) {
      await extensionsPage.close().catch(() => {});
      return installed;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for Chrome to load the extension from ${extensionPath}`
  );
}

async function ensureExtensionActionShortcut(
  context,
  extensionPage,
  extensionName
) {
  const readShortcut = () => extensionPage.evaluate(async () => {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === '_execute_action')
      ?.shortcut ?? '';
  });
  const existingShortcut = await readShortcut();
  if (existingShortcut) return existingShortcut;

  const shortcutsPage = await context.newPage();
  try {
    await shortcutsPage.goto('chrome://extensions/shortcuts');
    const shortcutInput = shortcutsPage.locator(
      `cr-shortcut-input[input-aria-label*="${extensionName}"]`
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
      + `"Activate the extension" for ${extensionName}.`
    );
  }
  return assignedShortcut;
}

async function main() {
  let options;
  try {
    options = parseRealMeetProfileCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${REAL_MEET_PROFILE_USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(REAL_MEET_PROFILE_USAGE);
    return;
  }

  console.log('Building the real-capture development extension');
  if (run('npm', ['run', 'dev']) !== 0) {
    process.exitCode = 1;
    return;
  }

  const extensionPath = path.resolve(process.cwd(), 'dist');
  const manifest = JSON.parse(
    await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8')
  );
  if (!manifest.key) {
    throw new Error('dist/manifest.json must contain a stable extension key');
  }
  const extensionId = extensionIdFromKey(manifest.key);
  await fs.mkdir(options.profilePath, { recursive: true });

  console.log(`Opening stable Chrome profile: ${options.profilePath}`);
  const context = await chromium.launchPersistentContext(options.profilePath, {
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    viewport: { width: 1280, height: 800 },
  });

  try {
    const extensionPage = await ensureExtensionInstalled(
      context,
      extensionId,
      extensionPath
    );
    const actionShortcut = await ensureExtensionActionShortcut(
      context,
      extensionPage,
      manifest.name
    );
    console.log(`Extension action shortcut ready: ${actionShortcut}`);
    const accountPage = await context.newPage();
    await accountPage.goto(
      'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmeet.google.com%2F',
      { waitUntil: 'domcontentloaded' }
    );

    const initialCookies = await context.cookies([
      'https://accounts.google.com',
      'https://meet.google.com',
    ]);
    console.log('');
    if (hasGoogleAccountSession(initialCookies)) {
      console.log('A Google account session is already present in this profile.');
      console.log('Use the account chooser only if you need to add or switch accounts.');
    } else {
      console.log('Sign in with the dedicated Google account used by live Meet tests.');
    }
    console.log('Do not use a personal Chrome profile or copy its cookie files.');
    console.log('Return here and press Enter after the account is signed in.');

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await readline.question('');
    readline.close();

    const cookies = await context.cookies([
      'https://accounts.google.com',
      'https://meet.google.com',
    ]);
    if (!hasGoogleAccountSession(cookies)) {
      throw new Error(
        'No Google account session was detected. Sign in before confirming the setup.'
      );
    }

    await extensionPage.reload({ waitUntil: 'domcontentloaded' });
    await extensionPage.waitForSelector('#save-settings', { timeout: 15_000 });
    await fs.writeFile(
      path.join(options.profilePath, '.real-meet-profile.json'),
      JSON.stringify(
        {
          version: 1,
          preparedAt: new Date().toISOString(),
          extensionId,
          googleSessionDetected: true,
        },
        null,
        2
      )
    );
    console.log('');
    console.log('Real-Meet profile is ready and the Google session is persisted.');
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
