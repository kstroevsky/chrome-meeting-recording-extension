import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';

type ListResponse = { ok: true; notations: unknown[] } | { ok: false; error: string };

/**
 * The standalone recordings page gains one NOTES column beside DUR that sorts
 * and feeds the existing "Search name or note" field (design section 09).
 */
test.describe('recordings page notes (integration)', () => {
  test('counts notes in their own column and searches their text', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });

      await meetPage.waitForTimeout(1_200);
      const marked = await sendRuntimeMessage<{ ok: true; notation: { id: string } }>(
        harness.controlPage,
        { type: 'MARK_NOTATION', text: 'pricing objection' },
      );
      expect(marked.ok).toBe(true);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });

      // The column exists and sorts.
      const notesHeader = page.getByRole('button', { name: /NOTES/ });
      await expect(notesHeader).toBeVisible();

      // The row shows a count chip plus the first note as a preview.
      await expect.poll(async () => await page.locator('.recording-row__notes-chip').first().textContent(), {
        timeout: 20_000,
      }).toBe('1');
      await expect(page.locator('.recording-row__notes-preview').first())
        .toHaveText(/^\d{2}:\d{2} pricing objection$/);

      // Searching the note's text keeps the recording; searching for something
      // absent from name, note and notes alike drops it.
      const search = page.getByPlaceholder('Search name or note…');
      await search.fill('pricing');
      await expect(page.locator('.recording-row')).toHaveCount(1);

      // The result says where the hit landed, and marks it in gold (f2).
      await expect(page.locator('.recording-day--match .recording-day__label').first())
        .toHaveText('MATCHED IN NOTES');
      await expect(page.locator('.recording-row__hit').first()).toHaveText('pricing');
      await expect(page.locator('.recordings-count')).toContainText('IN NAMES AND NOTES');

      await search.fill('nothing matches this');
      await expect(page.locator('.recording-row')).toHaveCount(0);

      // Typing must not cost the user their cursor: the toolbar is built once
      // and survives the repaint, so the caret stays where they left it.
      await search.fill('');
      await search.pressSequentially('pricing');
      await expect(page.locator('.recording-row')).toHaveCount(1);
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('recording-search');
      expect(await search.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe('pricing'.length);

      await notesHeader.click();
      await expect(page.locator('.recording-table__header')).toContainText('NOTES');
    } finally {
      await closeHarness(harness);
    }
  });
});
