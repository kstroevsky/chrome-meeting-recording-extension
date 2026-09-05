import { expect, test } from '@playwright/test';
import type { UploadJob } from '../../src/shared/recordingTypes';
import {
  closeHarness,
  findMockMeetTabId,
  getRecordingSession,
  launchExtensionHarness,
  openMockMeetPage,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';
import { installDriveSimulator } from './helpers/driveSimulator';

async function uploadJobs(controlPage: Parameters<typeof getRecordingSession>[0]): Promise<UploadJob[]> {
  const session = await getRecordingSession(controlPage) as unknown as { uploadJobs?: UploadJob[] };
  return session.uploadJobs ?? [];
}

test.describe('post-upload recording rename (integration)', () => {
  test('renames the Drive folder, media file, upload job, and history title', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const drive = await installDriveSimulator(harness.context, 'fast');
      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'drive',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await harness.controlPage.waitForTimeout(1_500);
      await stopRecording(harness.controlPage);

      await expect.poll(async () => {
        const jobs = await uploadJobs(harness.controlPage);
        return jobs.find((job) => job.status === 'completed')?.namingStatus;
      }, { timeout: 45_000 }).toBe('pending');

      const pending = (await uploadJobs(harness.controlPage)).find((job) => job.namingStatus === 'pending');
      expect(pending?.historyId).toBeTruthy();
      expect(pending?.driveFolderId).toBeTruthy();
      expect(pending?.files).toHaveLength(1);
      expect(pending?.files[0].driveFileId).toBeTruthy();

      const popup = await harness.context.newPage();
      await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
      });
      const input = popup.getByLabel('Recording name');
      await expect(input).toBeVisible();
      await expect(input).toHaveValue(pending!.label);
      await input.fill('Café – Product Review');
      await popup.locator('[data-recording-name-save]').click();
      await expect(input).toBeHidden();

      await expect.poll(async () => {
        const jobs = await uploadJobs(harness.controlPage);
        return jobs.find((job) => job.id === pending!.id)?.namingStatus;
      }, { timeout: 15_000 }).toBe('named');

      const namedJob = (await uploadJobs(harness.controlPage)).find((job) => job.id === pending!.id)!;
      expect(namedJob.label).toBe('Café – Product Review');
      expect(namedJob.driveFolderName).toBe('cafe-product-review');
      expect(namedJob.files[0].filename).toBe('cafe-product-review-recording.webm');

      const history = await sendRuntimeMessage<{
        ok: boolean;
        entries: Array<{
          id: string;
          name: string;
          userNamed?: boolean;
          driveFolderName?: string;
          files: Array<{ filename: string }>;
        }>;
      }>(harness.controlPage, { type: 'LIST_RECORDING_HISTORY' });
      const entry = history.entries.find((candidate) => candidate.id === pending!.historyId)!;
      expect(entry.name).toBe('Café – Product Review');
      expect(entry.userNamed).toBe(true);
      expect(entry.driveFolderName).toBe('cafe-product-review');
      expect(entry.files[0].filename).toBe('cafe-product-review-recording.webm');

      expect(drive.resources[pending!.driveFolderId!]).toBe('cafe-product-review');
      expect(drive.resources[pending!.files[0].driveFileId!]).toBe('cafe-product-review-recording.webm');
      expect(drive.metadataReads).toBeGreaterThanOrEqual(2);
      expect(drive.metadataUpdates).toBe(2);
      await popup.close();
    } finally {
      await closeHarness(harness);
    }
  });

  /**
   * The regression for the defect that cost a user an hour of microphone audio:
   * the notes sidecar took the mic row's identity, so two rows shared an id and
   * a rename then renamed the sidecar's Drive file to `-mic.webm`.
   *
   * Unit tests cover the guards; this covers the real upload path that produced
   * the bad data in the first place.
   */
  test('a mic recording with notes gives every artifact its own identity', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const drive = await installDriveSimulator(harness.context, 'fast');
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'drive',
        micMode: 'separate',
        recordSelfVideo: false,
      });
      await meetPage.waitForTimeout(1_200);
      // A note is what produces the WebVTT sidecar riding a media stream.
      const marked = await sendRuntimeMessage<{ ok: boolean }>(
        harness.controlPage, { type: 'MARK_NOTATION', text: 'decision point' });
      expect(marked.ok).toBe(true);
      await meetPage.waitForTimeout(800);
      await stopRecording(harness.controlPage);

      type Row = { id: string; stream: string; kind?: string; filename: string; driveFileId?: string };
      const readRows = async (): Promise<Row[]> => {
        const history = await sendRuntimeMessage<{ entries: Array<{ id: string; files: Row[] }> }>(
          harness.controlPage, { type: 'LIST_RECORDING_HISTORY' });
        return history.entries[0]?.files ?? [];
      };

      await expect.poll(async () => (await readRows()).filter((f) => f.driveFileId).length, {
        timeout: 45_000,
      }).toBe(3);

      const rows = await readRows();

      // Every artifact is its own row: no two share an id.
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);

      // And no two share a Drive file — a shared id is what let a rename
      // rename the wrong file.
      const driveIds = rows.map((r) => r.driveFileId!);
      expect(new Set(driveIds).size).toBe(driveIds.length);

      // The sidecar is a sidecar, by id, by kind and by extension.
      const notes = rows.find((r) => r.filename.endsWith('.vtt'))!;
      expect(notes).toBeDefined();
      expect(notes.id.endsWith(':notes')).toBe(true);
      expect(notes.kind).toBe('notes');
      const mic = rows.find((r) => r.stream === 'mic' && r.kind !== 'notes')!;
      expect(mic.id.endsWith(':mic')).toBe(true);
      expect(mic.filename).toMatch(/-mic\.webm$/);
      expect(mic.driveFileId).not.toBe(notes.driveFileId);

      // Renaming must not relabel the sidecar as media — this is the exact step
      // that turned a user's `-notes.vtt` into `-mic.webm`.
      const entryId = (await sendRuntimeMessage<{ entries: Array<{ id: string }> }>(
        harness.controlPage, { type: 'LIST_RECORDING_HISTORY' })).entries[0].id;
      const renamed = await sendRuntimeMessage<{ ok: boolean; error?: string }>(
        harness.controlPage, { type: 'RENAME_RECORDING_HISTORY', id: entryId, name: 'Weekly Sync' });
      expect(renamed.ok).toBe(true);

      const after = await readRows();
      const notesAfter = after.find((r) => r.id === notes.id)!;
      const micAfter = after.find((r) => r.id === mic.id)!;
      expect(notesAfter.filename).toMatch(/-notes\.vtt$/);
      expect(micAfter.filename).toMatch(/-mic\.webm$/);

      // Drive agrees: the sidecar's own file kept a .vtt name.
      expect(drive.resources[notes.driveFileId!]).toMatch(/-notes\.vtt$/);
      expect(drive.resources[mic.driveFileId!]).toMatch(/-mic\.webm$/);
    } finally {
      await closeHarness(harness);
    }
  });
});

