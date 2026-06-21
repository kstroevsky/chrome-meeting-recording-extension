/**
 * @file tests/e2e/settings-matrix.spec.ts
 *
 * Scenario A verification that every control on the extension Settings tab
 * actually changes recorder behaviour. Each saved (non-default) value is traced
 * to an observable effect: popup default run-config (basic settings), the perf
 * snapshot's capture/recorder start events (professional capture + chunking),
 * the adaptive-bitrate clamp, the finalized media artifact, and — for the
 * microphone DSP toggles — what real hardware reports back.
 *
 * Run against real devices:
 *   PW_REAL_MEDIA=1 PW_HEADLESS=0 npx playwright test settings-matrix
 */

import { expect, test, type TestInfo } from '@playwright/test';
import fs from 'node:fs/promises';
import type { PerfDebugSnapshot } from '../../src/shared/perf';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  probeHardwareMedia,
  readPerfSnapshot,
  setPerfSettings,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
  waitForPerfSnapshot,
  type DeviceMode,
  type ExtensionHarness,
} from './helpers/extensionHarness';
import { analyzeMediaArtifact, assertMediaToolsAvailable } from './helpers/mediaAnalysis';
import {
  applyFullRecordingSettings,
  baseRecordingSettings,
} from './helpers/recordingSettings';
import {
  SELF_VIDEO_DEFAULT_BITS_PER_SECOND,
  SELF_VIDEO_MIN_ADAPTIVE_BITS_PER_SECOND,
} from '../../src/shared/settings';

const REAL_MEDIA = process.env.PW_REAL_MEDIA === '1';
const DEVICE_MODE: DeviceMode = REAL_MEDIA ? 'hardware' : 'fake';

/** Returns the last perf entry matching scope/event (+ optional stream). */
function lastEntry(
  snapshot: PerfDebugSnapshot,
  scope: string,
  event: string,
  stream?: string
): Record<string, string | number | boolean | null> | null {
  const matches = snapshot.entries.filter(
    (e) =>
      e.scope === scope &&
      e.event === event &&
      (stream === undefined || e.fields.stream === stream)
  );
  return matches.length ? matches[matches.length - 1].fields : null;
}

async function attachJson(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  const file = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path: file, contentType: 'application/json' });
}

/** Skips a real-media test cleanly if the OS/devices are not available. */
async function ensureRealMediaOrSkip(harness: ExtensionHarness): Promise<void> {
  if (!REAL_MEDIA) return;
  const probe = await probeHardwareMedia(harness);
  test.skip(!probe.ok, `Real camera/mic unavailable: ${probe.error ?? 'no tracks'}`);
}

test.describe('Settings tab — every control changes recorder behaviour', () => {
  test('basic settings drive the popup default run config', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: 'fake',
    });
    try {
      // Variant 1: local + mixed mic + camera on.
      await applyFullRecordingSettings(harness.controlPage, baseRecordingSettings({
        recordingMode: 'opfs',
        micMode: 'mixed',
        separateCamera: true,
      }));
      let popup = await harness.context.newPage();
      await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(popup.locator('#storage-mode')).toHaveValue('local');
      await expect(popup.locator('#mic-mode')).toHaveValue('mixed');
      await expect(popup.locator('#record-self-video')).toBeChecked();
      await popup.close();

      // Variant 2: drive + mic off + camera off — opposite of variant 1.
      await applyFullRecordingSettings(harness.controlPage, baseRecordingSettings({
        recordingMode: 'drive',
        micMode: 'off',
        separateCamera: false,
      }));
      popup = await harness.context.newPage();
      await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(popup.locator('#storage-mode')).toHaveValue('drive');
      await expect(popup.locator('#mic-mode')).toHaveValue('off');
      await expect(popup.locator('#record-self-video')).not.toBeChecked();
      await popup.close();
    } finally {
      await closeHarness(harness);
    }
  });

  test('professional capture + chunking settings reach the recorder', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: DEVICE_MODE,
      headless: REAL_MEDIA ? false : undefined,
    });
    try {
      await ensureRealMediaOrSkip(harness);

      // Adaptive OFF so the camera uses the internal default (ceiling) bitrate
      // verbatim; extended-timeslice OFF so the mic recorder uses
      // chunkDefaultTimesliceMs (tab/cam use extended).
      await setPerfSettings(harness.controlPage, {
        adaptiveSelfVideoProfile: false,
        extendedTimeslice: false,
      });

      const tabVideoBitrateReference = 6_000_000;
      const s = baseRecordingSettings({
        recordingMode: 'opfs',
        micMode: 'separate',
        separateCamera: true,
        tabResolutionPreset: '1280x720',
        tabMaxFrameRate: 15,
        tabVideoBitrate: tabVideoBitrateReference,
        selfVideoResolutionPreset: '854x480',
        selfVideoFrameRate: 24,
        chunkDefaultTimesliceMs: 750,
        chunkExtendedTimesliceMs: 3_000,
        // Distinctive, mixed DSP toggles so each maps independently.
        micEchoCancellation: false,
        micNoiseSuppression: true,
        micAutoGain: false,
      });
      await applyFullRecordingSettings(harness.controlPage, s);

      await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await startRecording(harness.controlPage, tabId, {
        storageMode: 'local',
        micMode: 'separate',
        recordSelfVideo: true,
      });

      // Snapshot taken right after the three recorders start — few events so
      // far, so the per-stream start events are still in the 120-event buffer.
      const requiredStreams: Array<'tab' | 'mic' | 'self-video'> = ['tab', 'mic', 'self-video'];
      const startSnap = await waitForPerfSnapshot(
        harness.controlPage,
        (snap) =>
          requiredStreams.every(
            (st) => (snap.summary.recorder.startCountByStream[st] ?? 0) > 0
          ),
        30_000
      );
      await attachJson(testInfo, 'start-snapshot', startSnap);

      const tabCapture = lastEntry(startSnap, 'capture', 'stream_acquired', 'tab');
      const camCapture = lastEntry(startSnap, 'capture', 'stream_acquired', 'self-video');
      const tabRec = lastEntry(startSnap, 'recorder', 'recorder_started', 'tab');
      const micRec = lastEntry(startSnap, 'recorder', 'recorder_started', 'mic');
      const camRec = lastEntry(startSnap, 'recorder', 'recorder_started', 'self-video');

      // tabResolutionPreset + tabMaxFrameRate -> tab capture request.
      expect(tabCapture).not.toBeNull();
      expect(tabCapture!.requestedWidth).toBe(1280);
      expect(tabCapture!.requestedHeight).toBe(720);
      expect(tabCapture!.requestedFrameRate).toBe(15);
      // Synthetic tab source is deterministic: delivered == requested.
      expect(tabCapture!.width).toBe(1280);
      expect(tabCapture!.height).toBe(720);

      // selfVideoResolutionPreset + selfVideoFrameRate -> camera capture request.
      expect(camCapture).not.toBeNull();
      expect(camCapture!.requestedWidth).toBe(854);
      expect(camCapture!.requestedHeight).toBe(480);
      expect(camCapture!.requestedFrameRate).toBe(24);

      // Adaptive off -> the camera uses the internal default (ceiling) bitrate.
      expect(camRec).not.toBeNull();
      expect(camRec!.videoBitsPerSecond).toBe(SELF_VIDEO_DEFAULT_BITS_PER_SECOND);

      // chunkExtendedTimesliceMs -> tab + camera timeslice.
      expect(tabRec).not.toBeNull();
      expect(tabRec!.timesliceMs).toBe(3_000);
      expect(camRec!.timesliceMs).toBe(3_000);
      // chunkDefaultTimesliceMs -> mic timeslice (extended-timeslice flag off).
      expect(micRec).not.toBeNull();
      expect(micRec!.timesliceMs).toBe(750);

      // tabVideoBitrate -> tab MediaRecorder bitrate (scaled to resolution/fps),
      // now observable per-stream after the instrumentation fix.
      const ratio = (1280 * 720 * 15) / (1920 * 1080 * 30);
      const expectedTabBitrate = Math.min(
        Math.max(Math.round(tabVideoBitrateReference * ratio), 250_000),
        8_000_000
      );
      expect(tabRec!.videoBitsPerSecond).toBe(expectedTabBitrate);
      expect(startSnap.summary.recorder.lastVideoBitsPerSecondByStream.tab).toBe(expectedTabBitrate);
      expect(startSnap.summary.recorder.lastVideoBitsPerSecondByStream['self-video']).toBe(SELF_VIDEO_DEFAULT_BITS_PER_SECOND);

      // microphoneEcho/Noise/AutoGain -> mic getUserMedia constraints, now logged
      // (requested + applied) so the DSP toggles are observable.
      const micCapture = lastEntry(startSnap, 'capture', 'stream_acquired', 'mic');
      expect(micCapture).not.toBeNull();
      expect(micCapture!.requestedEchoCancellation).toBe(false);
      expect(micCapture!.requestedNoiseSuppression).toBe(true);
      expect(micCapture!.requestedAutoGainControl).toBe(false);
      await attachJson(testInfo, 'mic-constraints-observed', {
        event: micCapture,
        summary: startSnap.summary.capture.lastMicConstraints,
      });
      if (REAL_MEDIA) {
        // Real hardware applies the requested DSP toggles independently.
        expect(micCapture!.echoCancellation).toBe(false);
        expect(micCapture!.noiseSuppression).toBe(true);
        expect(micCapture!.autoGainControl).toBe(false);
      }

      await stopRecording(harness.controlPage);
      const downloads = await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        3,
        90_000
      );

      // tabResolutionPreset confirmed end-to-end in the encoded artifact.
      await assertMediaToolsAvailable();
      let confirmedTabDims = false;
      for (const dl of downloads) {
        const a = await analyzeMediaArtifact(dl.filename);
        const v = a.streams.find((st) => st.codecType === 'video');
        const hasAudio = a.streams.some((st) => st.codecType === 'audio');
        if (v && hasAudio && v.width === 1280 && v.height === 720) confirmedTabDims = true;
      }
      expect(confirmedTabDims).toBe(true);
    } finally {
      await closeHarness(harness);
    }
  });

  test('adaptive bitrate clamps the camera to the internal floor/ceiling envelope', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: DEVICE_MODE,
      headless: REAL_MEDIA ? false : undefined,
    });
    try {
      await ensureRealMediaOrSkip(harness);
      await setPerfSettings(harness.controlPage, { adaptiveSelfVideoProfile: true });

      // The camera bitrate envelope is internal (no user knob); the adaptive
      // estimate is clamped to this floor/ceiling.
      const ceiling = SELF_VIDEO_DEFAULT_BITS_PER_SECOND;
      const floor = SELF_VIDEO_MIN_ADAPTIVE_BITS_PER_SECOND;
      await applyFullRecordingSettings(harness.controlPage, baseRecordingSettings({
        recordingMode: 'opfs',
        micMode: 'off',
        separateCamera: true,
        selfVideoResolutionPreset: '854x480',
        selfVideoFrameRate: 24,
      }));

      await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await startRecording(harness.controlPage, tabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: true,
      });
      const startSnap = await waitForPerfSnapshot(
        harness.controlPage,
        (snap) => (snap.summary.recorder.startCountByStream['self-video'] ?? 0) > 0,
        30_000
      );
      await attachJson(testInfo, 'adaptive-start-snapshot', startSnap);

      const camCapture = lastEntry(startSnap, 'capture', 'stream_acquired', 'self-video');
      const camRec = lastEntry(startSnap, 'recorder', 'recorder_started', 'self-video');
      expect(camCapture).not.toBeNull();
      expect(camRec).not.toBeNull();

      const w = Number(camCapture!.width);
      const h = Number(camCapture!.height);
      const fps = Number(camCapture!.frameRate);
      // Mirrors resolveSelfVideoBitrate(): clamp(round(w*h*fps*0.1), floor, ceiling).
      const estimated = Math.round(w * h * fps * 0.1);
      const expectedBitrate = Math.min(Math.max(estimated, floor), ceiling);
      await attachJson(testInfo, 'adaptive-computation', {
        delivered: { w, h, fps },
        estimated,
        floor,
        ceiling,
        expectedBitrate,
        actual: camRec!.videoBitsPerSecond,
      });
      expect(camRec!.videoBitsPerSecond).toBe(expectedBitrate);

      await stopRecording(harness.controlPage);
    } finally {
      await closeHarness(harness);
    }
  });

  test('microphone DSP constraints are honoured by real hardware', async ({}, testInfo) => {
    test.skip(!REAL_MEDIA, 'Set PW_REAL_MEDIA=1 on a machine with a real microphone');
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: 'hardware',
      headless: false,
    });
    try {
      await ensureRealMediaOrSkip(harness);
      // Prove the device reports back the exact DSP toggle the extension would
      // request for getUserMedia (the extension passes this object verbatim).
      const readApplied = (constraints: MediaTrackConstraints) =>
        harness.controlPage.evaluate(async (audio) => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio });
          const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
          stream.getTracks().forEach((t) => t.stop());
          return settings as MediaTrackSettings;
        }, constraints);

      const allOn = await readApplied({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      const allOff = await readApplied({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
      await attachJson(testInfo, 'mic-dsp-applied', { allOn, allOff });

      // At least one DSP toggle must visibly differ between on and off, proving
      // the microphone constraint object the extension sends is meaningful here.
      const differs =
        allOn.echoCancellation !== allOff.echoCancellation ||
        allOn.noiseSuppression !== allOff.noiseSuppression ||
        allOn.autoGainControl !== allOff.autoGainControl;
      expect(differs).toBe(true);
    } finally {
      await closeHarness(harness);
    }
  });
});
