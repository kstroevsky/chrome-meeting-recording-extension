import type { Page } from '@playwright/test';
import type { MicMode } from '../../../src/shared/recording';
import type { ResolutionPreset } from '../../../src/shared/settings';

export type FullRecordingSettings = {
  recordingMode: 'opfs' | 'drive';
  micMode: MicMode;
  separateCamera: boolean;
  selfVideoResolutionPreset: ResolutionPreset;
  selfVideoBitrate: number;
  selfVideoFrameRate: number;
  selfVideoMinAdaptiveBitrate: number;
  tabResolutionPreset: ResolutionPreset;
  tabVideoBitrate: number;
  tabMaxFrameRate: number;
  micEchoCancellation: boolean;
  micNoiseSuppression: boolean;
  micAutoGain: boolean;
  chunkDefaultTimesliceMs: number;
  chunkExtendedTimesliceMs: number;
};

export async function applyFullRecordingSettings(
  page: Page,
  settings: FullRecordingSettings
): Promise<void> {
  await page.selectOption('#recording-mode', settings.recordingMode);
  await page.selectOption('#mic-mode', settings.micMode);
  await page.setChecked('#separate-camera', settings.separateCamera);
  await page.selectOption(
    '#self-video-resolution-preset',
    settings.selfVideoResolutionPreset
  );
  await page.fill('#self-video-bitrate', String(settings.selfVideoBitrate));
  await page.fill('#self-video-frame-rate', String(settings.selfVideoFrameRate));
  await page.fill(
    '#self-video-min-adaptive-bitrate',
    String(settings.selfVideoMinAdaptiveBitrate)
  );
  await page.selectOption('#tab-resolution-preset', settings.tabResolutionPreset);
  // NOTE: the tab video-bitrate input was removed — bitrate is now derived from the
  // content type's quality factor × delivered resolution (capped at the internal
  // ceiling), with no user knob. `settings.tabVideoBitrate` is retained in the e2e
  // config but no longer applied; the bitrate assertions in the specs predate the
  // #1/#2 model change and need realignment under a real Playwright run.
  await page.fill('#tab-max-frame-rate', String(settings.tabMaxFrameRate));
  await page.setChecked('#mic-echo-cancellation', settings.micEchoCancellation);
  await page.setChecked('#mic-noise-suppression', settings.micNoiseSuppression);
  await page.setChecked('#mic-auto-gain', settings.micAutoGain);
  await page.fill(
    '#chunk-default-timeslice',
    String(settings.chunkDefaultTimesliceMs)
  );
  await page.fill(
    '#chunk-extended-timeslice',
    String(settings.chunkExtendedTimesliceMs)
  );
  await page.click('#save-settings');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'Saved'
  );
}

export function baseRecordingSettings(
  overrides: Partial<FullRecordingSettings> = {}
): FullRecordingSettings {
  return {
    recordingMode: 'opfs',
    micMode: 'separate',
    separateCamera: true,
    selfVideoResolutionPreset: '1920x1080',
    selfVideoBitrate: 3_000_000,
    selfVideoFrameRate: 30,
    selfVideoMinAdaptiveBitrate: 1_000_000,
    tabResolutionPreset: '1920x1080',
    tabVideoBitrate: 1_500_000,
    tabMaxFrameRate: 30,
    micEchoCancellation: true,
    micNoiseSuppression: true,
    micAutoGain: true,
    chunkDefaultTimesliceMs: 2_000,
    chunkExtendedTimesliceMs: 4_000,
    ...overrides,
  };
}
