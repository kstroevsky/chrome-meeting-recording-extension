import { expect, test, type Page } from '@playwright/test';
import {
  closeHarness,
  launchExtensionHarness,
  sendRuntimeMessage,
} from './helpers/extensionHarness';

const COUNT = 120; // Pages are 50, so this takes two automatic loads after the first.

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
        const id = `scroll-${String(index).padStart(3, '0')}`;
        const createdAt = 1_700_000_000_000 + index * 60_000;
        store.put({
          id,
          name: `Scroll recording ${index + 1}`,
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

test('the recordings list loads further pages as it is scrolled, with no Load more button', async ({}, testInfo) => {
  const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
  try {
    await seedRecordings(harness.controlPage, COUNT);
    const page = await harness.context.newPage();
    await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`);

    const rows = page.locator('.recording-row');
    await expect(rows).toHaveCount(50);
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);
    await expect(page.locator('.recordings-count')).toHaveText(`${COUNT} RECORDINGS`);

    const scroller = page.locator('.recording-table__scroll');
    // Scrolled the way a person does — the wheel over the list — so the scroll
    // always reaches the list on screen, even if a redraw has just replaced it.
    const scrollUntil = async (count: number) => {
      const box = (await scroller.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(async () => {
        await page.mouse.wheel(0, 2_000);
        return rows.count();
      }).toBe(count);
    };

    await scrollUntil(100);
    // The list stays where it was scrolled while the page appends below.
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await scrollUntil(COUNT);
    await expect(page.locator('.recording-table__more')).toHaveCount(0);
    await expect(rows.last()).toContainText('Scroll recording 1');
  } finally {
    await closeHarness(harness);
  }
});
