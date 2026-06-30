import type { Page } from '@playwright/test';
import type { MicMode } from '../../../src/shared/recording';
import type { ResolutionPreset, TabContentType } from '../../../src/shared/settings';

export type FullRecordingSettings = {
  recordingMode: 'opfs' | 'drive';
  micMode: MicMode;
  separateCamera: boolean;
  selfVideoResolutionPreset: ResolutionPreset;
  selfVideoFrameRate: number;
  tabResolutionPreset: ResolutionPreset;
  tabContentType: TabContentType;
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
  await page.fill('#self-video-frame-rate', String(settings.selfVideoFrameRate));
  await page.selectOption('#tab-resolution-preset', settings.tabResolutionPreset);
  // The tab bitrate is automatic: the content-type quality factor (screen vs. video)
  // × the delivered resolution/fps, with no explicit bitrate knob. `tabContentType`
  // selects that factor and is applied here. The camera bitrate is likewise automatic
  // (delivered W×H×fps within an internal floor/ceiling), so no bitrate knobs remain.
  await page.selectOption('#tab-content-type', settings.tabContentType);
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
    selfVideoFrameRate: 30,
    tabResolutionPreset: '1920x1080',
    tabContentType: 'screen',
    tabMaxFrameRate: 30,
    micEchoCancellation: true,
    micNoiseSuppression: true,
    micAutoGain: true,
    chunkDefaultTimesliceMs: 2_000,
    chunkExtendedTimesliceMs: 4_000,
    ...overrides,
  };
}
