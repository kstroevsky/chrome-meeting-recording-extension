import { expect, test } from '@playwright/test';
import {
  assertPopupReflectsSavedDefaults,
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  sendTabMessage,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
  waitForSessionPhase,
  type TranscriptResponse,
} from './helpers/extensionHarness';

test.describe('mock Meet extension E2E', () => {
  test('injects into the mocked Meet origin and serves transcript messages', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      const initialTranscript = await sendTabMessage<TranscriptResponse>(
        harness.controlPage,
        meetTabId,
        { type: 'GET_TRANSCRIPT' }
      );
      expect(initialTranscript.provider).toEqual({
        providerId: 'google-meet',
        meetingId: 'abc-defg-hij',
        supportsCaptions: true,
      });
      expect(initialTranscript.transcript).toContain(
        'Alice Example : Initial caption from mocked Meet'
      );

      await meetPage.evaluate(() =>
        (window as any).mockMeet.setCaption('Updated Scenario A caption')
      );

      await expect.poll(async () => {
        const response = await sendTabMessage<TranscriptResponse>(
          harness.controlPage,
          meetTabId,
          { type: 'GET_TRANSCRIPT' }
        );
        return response.transcript;
      }).toContain('Alice Example : Updated Scenario A caption');

      expect(await sendTabMessage(
        harness.controlPage,
        meetTabId,
        { type: 'RESET_TRANSCRIPT' }
      )).toEqual({ ok: true });

      const afterReset = await sendTabMessage<TranscriptResponse>(
        harness.controlPage,
        meetTabId,
        { type: 'GET_TRANSCRIPT' }
      );
      expect(afterReset.transcript.trim()).toBe('');
    } finally {
      await closeHarness(harness);
    }
  });

  test('persists local defaults, records the mocked Meet tab, and auto-stops on ended DOM', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage);
      await assertPopupReflectsSavedDefaults(harness);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });

      await meetPage.waitForTimeout(2_000);
      await meetPage.evaluate(() => (window as any).mockMeet.endMeeting());
      await waitForSessionPhase(harness.controlPage, 'idle', 75_000);

      expect(await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        1,
        45_000
      )).toHaveLength(1);
    } finally {
      await closeHarness(harness);
    }
  });

  test('recreates a stale offscreen document on build-id mismatch and still records', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage); // local, mic off, no camera → 1 file/run

      const getServiceWorker = async () => {
        let [sw] = harness.context.serviceWorkers();
        if (!sw) sw = await harness.context.waitForEvent('serviceworker', { timeout: 30_000 });
        return sw;
      };
      const offscreenDocumentId = async (): Promise<string | null> => {
        const sw = await getServiceWorker();
        return await sw.evaluate(async () => {
          const contexts = await (chrome.runtime as any).getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
          });
          return contexts[0]?.documentId ?? null;
        });
      };
      const waitForRecreatedOffscreen = async (
        previous: string | null,
        timeoutMs = 15_000
      ): Promise<string> => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const id = await offscreenDocumentId();
          if (id && id !== previous) return id;
          await harness.controlPage.waitForTimeout(200);
        }
        throw new Error('Offscreen document was not recreated after build-id mismatch');
      };

      // First recording creates the offscreen document.
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const firstDocId = await offscreenDocumentId();
      expect(typeof firstDocId).toBe('string');
      await harness.controlPage.waitForTimeout(1_500);
      await stopRecording(harness.controlPage);
      expect(await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        1,
        45_000
      )).toHaveLength(1);

      // Simulate a rebuild/update: make the service worker expect a different
      // build id than the still-alive offscreen reports, then drive the same
      // reconnect handshake the SW runs after a restart. This is exactly the
      // skew that occurs after `npm run dev` + reload or a production update.
      const sw = await getServiceWorker();
      await sw.evaluate(() => {
        (globalThis as any).__BUILD_ID__ = `forced-stale-${Date.now()}`;
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' });
      });

      // The handshake must detect the stale offscreen and recreate it from
      // current code (new documentId).
      const secondDocId = await waitForRecreatedOffscreen(firstDocId);
      expect(secondDocId).not.toBe(firstDocId); // proves the offscreen was recreated

      // Recording must still work end-to-end on the recreated offscreen.
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await harness.controlPage.waitForTimeout(1_500);
      await stopRecording(harness.controlPage);
      expect(await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        2,
        45_000
      )).toHaveLength(2);
    } finally {
      await closeHarness(harness);
    }
  });

  test('records separate microphone and self-video artifacts with fake media devices', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);

      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local',
        micMode: 'separate',
        recordSelfVideo: true,
      });

      await harness.controlPage.waitForTimeout(2_000);
      await stopRecording(harness.controlPage);

      expect(await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        3,
        45_000
      )).toHaveLength(3);
    } finally {
      await closeHarness(harness);
    }
  });
});
