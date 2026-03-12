import { readFileSync } from 'fs';
import { resolve } from 'path';

import type { ExtensionSettings } from '../src/shared/extensionSettings';

const settingsHtml = readFileSync(
  resolve(__dirname, '../static/settings.html'),
  'utf8'
);

describe('settings page', () => {
  const savedSettings: ExtensionSettings = {
    basic: {
      recordingMode: 'drive',
      microphoneRecordingMode: 'separate',
      separateCameraCapture: true,
      selfVideoResolutionPreset: '1280x720',
    },
    professional: {
      selfVideoBitrate: 3_000_000,
      selfVideoFrameRate: 30,
      selfVideoMinAdaptiveBitrate: 1_000_000,
      tabResolutionPreset: '854x480',
      tabMaxFrameRate: 24,
      tabResizePostprocess: false,
      tabMp4Output: false,
      selfVideoMp4Output: false,
      microphoneEchoCancellation: true,
      microphoneNoiseSuppression: true,
      microphoneAutoGainControl: true,
      chunkDefaultTimesliceMs: 2000,
      chunkExtendedTimesliceMs: 4000,
    },
  };

  beforeEach(() => {
    jest.resetModules();
    document.open();
    document.write(settingsHtml);
    document.close();
  });

  it('applies stored preset settings and saves updated preset fields', async () => {
    const loadExtensionSettingsFromStorage = jest.fn().mockResolvedValue(savedSettings);
    const saveExtensionSettingsToStorage = jest.fn().mockImplementation(async (value: unknown) => value);
    const resetExtensionSettingsToDefaults = jest.fn().mockResolvedValue(savedSettings);

    jest.doMock('../src/shared/extensionSettings', () => ({
      DEFAULT_EXTENSION_SETTINGS: savedSettings,
      loadExtensionSettingsFromStorage,
      saveExtensionSettingsToStorage,
      resetExtensionSettingsToDefaults,
    }));

    jest.isolateModules(() => {
      require('../src/settings');
    });
    await Promise.resolve();

    expect((document.getElementById('self-video-resolution-preset') as HTMLSelectElement).value).toBe('1280x720');
    expect((document.getElementById('tab-resolution-preset') as HTMLSelectElement).value).toBe('854x480');

    (document.getElementById('recording-mode') as HTMLSelectElement).value = 'opfs';
    (document.getElementById('mic-mode') as HTMLSelectElement).value = 'mixed';
    (document.getElementById('separate-camera') as HTMLInputElement).checked = false;
    (document.getElementById('self-video-resolution-preset') as HTMLSelectElement).value = '640x360';
    (document.getElementById('tab-resolution-preset') as HTMLSelectElement).value = '1920x1080';
    (document.getElementById('tab-resize-postprocess') as HTMLInputElement).checked = true;
    (document.getElementById('tab-mp4-output') as HTMLInputElement).checked = true;
    (document.getElementById('self-video-mp4-output') as HTMLInputElement).checked = true;
    (document.getElementById('save-settings') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(saveExtensionSettingsToStorage).toHaveBeenCalledWith({
      basic: {
        recordingMode: 'opfs',
        microphoneRecordingMode: 'mixed',
        separateCameraCapture: false,
        selfVideoResolutionPreset: '640x360',
      },
      professional: {
        selfVideoBitrate: 3000000,
        selfVideoFrameRate: 30,
        selfVideoMinAdaptiveBitrate: 1000000,
        tabResolutionPreset: '1920x1080',
        tabMaxFrameRate: 24,
        tabResizePostprocess: true,
        tabMp4Output: true,
        selfVideoMp4Output: true,
        microphoneEchoCancellation: true,
        microphoneNoiseSuppression: true,
        microphoneAutoGainControl: true,
        chunkDefaultTimesliceMs: 2000,
        chunkExtendedTimesliceMs: 4000,
      },
    });
    expect(document.getElementById('status')?.textContent).toBe('Saved');
  });

  it('toggles tooltips on click and closes them on outside click or Escape', async () => {
    jest.doMock('../src/shared/extensionSettings', () => ({
      DEFAULT_EXTENSION_SETTINGS: savedSettings,
      loadExtensionSettingsFromStorage: jest.fn().mockResolvedValue(savedSettings),
      saveExtensionSettingsToStorage: jest.fn().mockResolvedValue(savedSettings),
      resetExtensionSettingsToDefaults: jest.fn().mockResolvedValue(savedSettings),
    }));

    jest.isolateModules(() => {
      require('../src/settings');
    });
    await Promise.resolve();

    const toggle = document.querySelector('.tooltip-toggle') as HTMLButtonElement;
    const bubble = document.getElementById(toggle.getAttribute('aria-controls')!) as HTMLElement;

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(bubble.hidden).toBe(false);

    document.body.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bubble.hidden).toBe(true);

    toggle.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bubble.hidden).toBe(true);
  });
});
