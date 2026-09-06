import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';
import { installDriveSimulator } from './helpers/driveSimulator';

/**
 * Drive destinations are user-authored folder names, so the settings page is
 * where they are created, renamed and removed. Uploads still land in the
 * built-in folder; a destination is what a recording is sorted into afterwards.
 */
const names = async (page: import('@playwright/test').Page) =>
  await page.locator('.destination-name').evaluateAll(
    (inputs) => inputs.map((input) => (input as HTMLInputElement).value));

test.describe('Drive destinations (integration)', () => {
  test('creates, renames, removes and persists destinations', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const page = await harness.context.newPage();
      const open = async () => {
        await page.goto(`chrome-extension://${harness.extensionId}/settings.html`, {
          waitUntil: 'domcontentloaded',
        });
        // The list itself is an empty flex box until it has rows, so wait on the control.
        await expect(page.locator('#destination-add')).toBeVisible();
      };
      await open();

      // Starts empty: every recording goes to the built-in folder until asked otherwise.
      await expect(page.locator('.destination-row')).toHaveCount(0);

      for (const name of ['Work meetings', 'Psychotherapy', 'Interviews']) {
        await page.locator('#destination-add').click();
        await page.locator('.destination-name').last().fill(name);
      }
      await expect(page.locator('.destination-row')).toHaveCount(3);
      await page.locator('#save-settings').click();

      await open();
      expect(await names(page)).toEqual(['Work meetings', 'Psychotherapy', 'Interviews']);

      // Renaming keeps the row; removing takes only that row.
      await page.locator('.destination-name').nth(1).fill('Therapy');
      await page.locator('.destination-remove').nth(0).click();
      await expect(page.locator('.destination-row')).toHaveCount(2);
      await page.locator('#save-settings').click();

      await open();
      expect(await names(page)).toEqual(['Therapy', 'Interviews']);

      // A blank row is not a destination.
      await page.locator('#destination-add').click();
      await page.locator('#save-settings').click();
      await open();
      await expect(page.locator('.destination-row')).toHaveCount(2);
    } finally {
      await closeHarness(harness);
    }
  });

  test('files a Drive recording into a destination and back out again', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const drive = await installDriveSimulator(harness.context, 'fast');
      const settings = await harness.context.newPage();
      await settings.goto(`chrome-extension://${harness.extensionId}/settings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await settings.locator('#destination-add').click();
      await settings.locator('.destination-name').last().fill('Psychotherapy');
      await settings.locator('#save-settings').click();
      await settings.close();

      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'drive', micMode: 'off', recordSelfVideo: false,
      });
      await harness.controlPage.waitForTimeout(1_200);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 30_000 });
      // Filing needs the recording's Drive folder, which exists only once the
      // upload has created it.
      await expect.poll(async () => await page.evaluate(async () => {
        const res: any = await new Promise((r) => chrome.runtime.sendMessage({ type: 'LIST_RECORDING_HISTORY' }, r));
        return Boolean(res?.entries?.[0]?.driveFolderId);
      }), { timeout: 45_000 }).toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.recording-row').first().click();

      // Driven through the listbox the user actually sees, not the native
      // select it keeps as its value holder.
      const trigger = page.locator('.detail-destination__select .select-trigger');
      const chooseDestination = async (label: string) => {
        await trigger.click();
        await page.locator('.detail-destination__select [role="option"]', { hasText: label }).click();
      };

      // A recording made before it was filed reads as unfiled, not as a guess.
      await expect(trigger).toBeVisible({ timeout: 20_000 });
      await expect(trigger).toHaveText('Google Meet Records (unfiled)');

      await chooseDestination('Psychotherapy');
      await expect.poll(() => Object.values(drive.resources).includes('Psychotherapy'), {
        timeout: 20_000,
      }).toBe(true);
      // The recording's folder was re-parented; the media inside it never moved.
      await expect.poll(() => drive.folderMoves, { timeout: 20_000 }).toBeGreaterThan(0);

      // The choice survives a reload, because it is recorded in history.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.recording-row').first().click();
      await expect(trigger).toHaveText('Psychotherapy', { timeout: 20_000 });

      // And it can be unfiled again — back to the built-in folder.
      const movesBefore = drive.folderMoves;
      await chooseDestination('Google Meet Records (unfiled)');
      await expect.poll(() => drive.folderMoves, { timeout: 20_000 }).toBeGreaterThan(movesBefore);
      await expect(trigger).toHaveText('Google Meet Records (unfiled)', { timeout: 20_000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.recording-row').first().click();
      await expect(trigger).toHaveText('Google Meet Records (unfiled)');
    } finally {
      await closeHarness(harness);
    }
  });
});

