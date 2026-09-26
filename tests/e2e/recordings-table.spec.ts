import { expect, test, type Page } from '@playwright/test';
import {
  closeHarness,
  launchExtensionHarness,
  sendRuntimeMessage,
} from './helpers/extensionHarness';

/** Four recordings: two in "Therapy" (one on Drive, one in Downloads), one in "Work", one unfiled. */
async function seed(page: Page): Promise<void> {
  // Background owns the schema: let it open the database before this page does.
  await sendRuntimeMessage(page, { type: 'LIST_RECORDING_HISTORY' });
  await page.evaluate(async () => {
    const stored = (await chrome.storage.local.get('extensionSettings')).extensionSettings ?? {};
    await chrome.storage.local.set({
      extensionSettings: { ...stored, storage: { ...(stored.storage ?? {}), driveFolderPresets: [{ id: 'therapy', name: 'Therapy' }, { id: 'work', name: 'Work' }] } },
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('recording-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows: Array<[string, number, { driveFolderPresetId?: string; localFolderName?: string }]> = [
      ['Session one', 50, { driveFolderPresetId: 'therapy' }],
      ['Planning', 30, { driveFolderPresetId: 'work' }],
      ['Standup', 10, {}],
      ['Session two', 25, { localFolderName: 'Therapy' }],
    ];
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('recordings', 'readwrite');
      const store = transaction.objectStore('recordings');
      rows.forEach(([name, minutes, folder], index) => {
        const id = `table-${index}`;
        const createdAt = 1_760_000_000_000 - index * 3_600_000;
        const destination = folder.driveFolderPresetId ? 'drive' : 'local';
        store.put({
          id, name, createdAt, activeCreatedAt: createdAt, storageMode: destination, status: 'complete',
          durationMs: minutes * 60_000, ...folder,
          files: [{ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination, status: 'available', bytes: minutes * 1_048_576 }],
        });
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

test('the recordings table sorts both ways and filters by folder tag', async ({}, testInfo) => {
  const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
  try {
    await seed(harness.controlPage);
    const page = await harness.context.newPage();
    await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`);
    const names = page.locator('.recording-row__name-text');
    await expect(names).toHaveCount(4);
    await expect(page.locator('.recording-row__remove')).toHaveCount(0);

    const header = (label: string) => page.locator('.table-header-button', { hasText: label });
    await header('DUR').click();
    await expect(names).toHaveText(['Session one', 'Planning', 'Session two', 'Standup']);
    await header('DUR').click();
    await expect(names).toHaveText(['Standup', 'Session two', 'Planning', 'Session one']);
    await header('SIZE').click();
    await expect(names).toHaveText(['Session one', 'Planning', 'Session two', 'Standup']);
    await header('SIZE').click();
    await expect(names).toHaveText(['Standup', 'Session two', 'Planning', 'Session one']);

    // Still smallest first: Session two (Therapy), Planning (Work), Session one (Therapy); Standup is unfiled.
    await expect(page.locator('.recording-row__folder')).toHaveText(['Therapy', 'Work', 'Therapy']);
    await page.locator('.recording-row__folder', { hasText: 'Therapy' }).first().click();
    await expect(names).toHaveText(['Session two', 'Session one']);
    await expect(page.locator('.recording-detail')).toHaveCount(0);
    await expect(page.locator('.recordings-count')).toHaveText('2 OF 4');
    await page.locator('.folder-filter-chip').click();
    await expect(names).toHaveCount(4);
  } finally {
    await closeHarness(harness);
  }
});
