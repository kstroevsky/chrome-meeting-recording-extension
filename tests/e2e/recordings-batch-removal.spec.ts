import { expect, test, type Page } from '@playwright/test';
import {
  closeHarness,
  launchExtensionHarness,
  sendRuntimeMessage,
} from './helpers/extensionHarness';

const COUNT = 35;

/** Writes finished local recordings straight into the library store. */
async function seedRecordings(page: Page, count: number): Promise<void> {
  // Background owns the schema: let it open the database before this page does.
  await sendRuntimeMessage(page, { type: 'LIST_RECORDING_HISTORY' });
  await page.evaluate(async (total) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('recording-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('recordings', 'readwrite');
      const store = transaction.objectStore('recordings');
      for (let index = 0; index < total; index += 1) {
        const id = `batch-${String(index).padStart(2, '0')}`;
        const createdAt = 1_700_000_000_000 + index * 60_000;
        store.put({
          id,
          name: `Batch recording ${index + 1}`,
          createdAt,
          activeCreatedAt: createdAt,
          storageMode: 'local',
          status: 'complete',
          files: [{ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'local', status: 'available' }],
        });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, count);
}

test('removing many recordings shows progress, guards the page, and summarises', async ({}, testInfo) => {
  const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
  try {
    await seedRecordings(harness.controlPage, COUNT);

    const page = await harness.context.newPage();
    // Each removal is made a little slower than a local one, so the run lasts
    // long enough to watch — a Drive-backed removal is far slower than this.
    await page.addInitScript(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (...args: any[]) => any;
      (chrome.runtime as any).sendMessage = async (message: any, ...rest: any[]) => {
        if (message?.type === 'REMOVE_RECORDING_HISTORY') await new Promise((resolve) => setTimeout(resolve, 120));
        return send(message, ...rest);
      };
    });
    await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`);
    await expect(page.locator('.recording-row')).toHaveCount(COUNT);

    await page.getByRole('button', { name: 'Select all shown' }).click();
    await page.locator('.bulk-toolbar').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.locator('.confirm-card__confirm').click();

    const dialog = page.locator('.removal-card');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Removing ${COUNT} recordings`);
    await expect(dialog).toContainText('Keep this page open until it finishes');

    // Progress moves and rows leave while the run is still going.
    const progress = dialog.getByRole('progressbar');
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(3);
    await expect.poll(async () => page.locator('.recording-row').count()).toBeLessThan(COUNT - 3);
    await expect(dialog.locator('.removal-status')).toContainText(`of ${COUNT} · Removing “Batch recording`);

    // Leaving mid-run asks first; staying keeps the run going.
    const asked = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const leave = await asked;
    expect(leave.type()).toBe('beforeunload');
    await leave.dismiss();
    expect(page.isClosed()).toBe(false);

    await expect(dialog.locator('.confirm-card__title')).toHaveText(`Removed ${COUNT} of ${COUNT} recordings`, { timeout: 30_000 });
    await expect(dialog.locator('.removal-status')).toHaveText('Done.');
    await expect(page.locator('.recording-row')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    const library = await sendRuntimeMessage<{ ok: boolean; entries: unknown[] }>(
      harness.controlPage,
      { type: 'LIST_RECORDING_HISTORY' },
    );
    expect(library.entries).toEqual([]);
  } finally {
    await closeHarness(harness);
  }
});
