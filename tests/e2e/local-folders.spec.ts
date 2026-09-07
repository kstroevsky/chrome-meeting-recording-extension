import { expect, test } from '@playwright/test';
import { closeHarness, launchExtensionHarness } from './helpers/extensionHarness';

/**
 * Download sub-folders, kept as their own list because they are a different
 * place from Drive with stricter naming rules, and because a local recording is
 * filed as it is written rather than moved afterwards.
 */
test.describe('local folders (integration)', () => {
  test('creates, sanitises and persists local folders, separately from Drive', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const page = await harness.context.newPage();
      const open = async () => {
        await page.goto(`chrome-extension://${harness.extensionId}/settings.html`, {
          waitUntil: 'domcontentloaded',
        });
        await expect(page.locator('#local-folder-add')).toBeVisible();
      };
      const localNames = async () =>
        await page.locator('#local-folders-list .destination-name').evaluateAll(
          (inputs) => inputs.map((input) => (input as HTMLInputElement).value));
      const driveNames = async () =>
        await page.locator('#destinations-list .destination-name').evaluateAll(
          (inputs) => inputs.map((input) => (input as HTMLInputElement).value));

      await open();
      await expect(page.locator('#local-folders-list .destination-row')).toHaveCount(0);

      // A folder in each list, to prove they are independent.
      await page.locator('#destination-add').click();
      await page.locator('#destinations-list .destination-name').last().fill('Psychotherapy');
      for (const name of ['Therapy 2026', 'Client work']) {
        await page.locator('#local-folder-add').click();
        await page.locator('#local-folders-list .destination-name').last().fill(name);
      }
      await page.locator('#save-settings').click();

      await open();
      expect(await localNames()).toEqual(['Therapy 2026', 'Client work']);
      expect(await driveNames()).toEqual(['Psychotherapy']);

      // Characters that cannot be a path segment are stripped on save, not
      // silently written into a folder name the OS would reject.
      await page.locator('#local-folder-add').click();
      await page.locator('#local-folders-list .destination-name').last().fill('Q1: notes <draft>');
      await page.locator('#save-settings').click();
      await open();
      expect(await localNames()).toEqual(['Therapy 2026', 'Client work', 'Q1 notes draft']);

      // Removing one leaves the other list alone.
      await page.locator('#local-folders-list .destination-remove').first().click();
      await page.locator('#save-settings').click();
      await open();
      expect(await localNames()).toEqual(['Client work', 'Q1 notes draft']);
      expect(await driveNames()).toEqual(['Psychotherapy']);

      // Reset clears both lists on screen, not just in storage.
      await page.locator('#reset-settings').click();
      await expect(page.locator('#local-folders-list .destination-row')).toHaveCount(0);
      await expect(page.locator('#destinations-list .destination-row')).toHaveCount(0);
      await open();
      expect(await localNames()).toEqual([]);
      expect(await driveNames()).toEqual([]);
    } finally {
      await closeHarness(harness);
    }
  });
});

test.describe('local playback storage (integration)', () => {
  test('reports what the retained library costs and whether it can be evicted', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/settings.html`, {
        waitUntil: 'domcontentloaded',
      });

      // A real figure, not the "Checking…" placeholder and not "Unavailable".
      const usage = page.locator('#storage-usage');
      await expect(usage).not.toHaveText('Checking…', { timeout: 20_000 });
      await expect(usage).not.toHaveText('Unavailable');
      await expect(usage).toContainText(/\d/);
      await expect(usage.locator('small')).toContainText(/used by this extension|unavailable/i);
    } finally {
      await closeHarness(harness);
    }
  });
});
