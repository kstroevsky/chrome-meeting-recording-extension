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
