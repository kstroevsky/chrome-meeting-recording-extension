import { readFileSync } from 'fs';
import { resolve } from 'path';

import type { ExtensionSettings } from './shared/settings';

const settingsHtml = readFileSync(
  resolve(__dirname, '../static/settings.html'),
  'utf8'
);

describe('settings page', () => {
  const savedSettings: ExtensionSettings = {
    storage: { driveFolderPresets: [] },
    privacy: {
      anonymousDiagnostics: true,
    },
    appearance: {
      theme: 'dark',
    },
    basic: {
      recordingMode: 'drive',
      microphoneRecordingMode: 'separate',
      separateCameraCapture: true,
      tabRecordingFormat: 'webm',
      cameraRecordingFormat: 'webm',
      microphoneRecordingFormat: 'webm',
      selfVideoResolutionPreset: '1280x720',
      selfVideoUseAutoResolution: true,
    },
    professional: {
      selfVideoFrameRate: 30,
      tabContentType: 'screen' as const,
      tabResolutionPreset: '854x480',
      tabMaxFrameRate: 24,
      microphoneEchoCancellation: true,
      microphoneNoiseSuppression: true,
      microphoneAutoGainControl: true,
      chunkDefaultTimesliceMs: 2000,
      chunkExtendedTimesliceMs: 4000,
    },
  };

  beforeEach(() => {
    jest.resetModules();
    (MediaRecorder.isTypeSupported as jest.Mock).mockReset().mockReturnValue(true);
    document.open();
    document.write(settingsHtml);
    document.close();
  });

  it('applies stored preset settings and saves updated preset fields', async () => {
    const loadExtensionSettingsFromStorage = jest.fn().mockResolvedValue(savedSettings);
    const saveExtensionSettingsToStorage = jest.fn().mockImplementation(async (value: unknown) => value);
    const resetExtensionSettingsToDefaults = jest.fn().mockResolvedValue(savedSettings);

    jest.doMock('./shared/settings', () => ({
      DEFAULT_EXTENSION_SETTINGS: savedSettings,
      loadExtensionSettingsFromStorage,
      saveExtensionSettingsToStorage,
      resetExtensionSettingsToDefaults,
    }));

    jest.isolateModules(() => {
      require('./settings');
    });
    await Promise.resolve();

    expect((document.getElementById('self-video-resolution-preset') as HTMLSelectElement).value).toBe('1280x720');
    expect((document.getElementById('tab-resolution-preset') as HTMLSelectElement).value).toBe('854x480');
    expect((document.getElementById('theme') as HTMLSelectElement).value).toBe('dark');
    expect((document.getElementById('anonymous-diagnostics') as HTMLInputElement).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    (document.getElementById('theme') as HTMLSelectElement).value = 'light';
    (document.getElementById('anonymous-diagnostics') as HTMLInputElement).checked = false;
    (document.getElementById('recording-mode') as HTMLSelectElement).value = 'opfs';
    (document.getElementById('mic-mode') as HTMLSelectElement).value = 'mixed';
    (document.getElementById('separate-camera') as HTMLInputElement).checked = false;
    (document.getElementById('tab-recording-format') as HTMLSelectElement).value = 'webm';
    (document.getElementById('camera-recording-format') as HTMLSelectElement).value = 'webm';
    (document.getElementById('microphone-recording-format') as HTMLSelectElement).value = 'webm';
    (document.getElementById('self-video-resolution-preset') as HTMLSelectElement).value = '640x360';
    (document.getElementById('tab-resolution-preset') as HTMLSelectElement).value = '1920x1080';
    (document.getElementById('save-settings') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(saveExtensionSettingsToStorage).toHaveBeenCalledWith({
      storage: { driveFolderPresets: [] },
      privacy: {
        anonymousDiagnostics: false,
      },
      appearance: {
        theme: 'light',
      },
      basic: {
        recordingMode: 'opfs',
        microphoneRecordingMode: 'mixed',
        separateCameraCapture: false,
        tabRecordingFormat: 'webm',
        cameraRecordingFormat: 'webm',
        microphoneRecordingFormat: 'webm',
        selfVideoResolutionPreset: '640x360',
        selfVideoUseAutoResolution: true,
      },
      professional: {
        selfVideoFrameRate: 30,
        tabContentType: 'screen',
        tabResolutionPreset: '1920x1080',
        tabMaxFrameRate: 24,
        microphoneEchoCancellation: true,
        microphoneNoiseSuppression: true,
        microphoneAutoGainControl: true,
        chunkDefaultTimesliceMs: 2000,
        chunkExtendedTimesliceMs: 4000,
      },
    });
    expect(document.getElementById('status')?.textContent).toBe('Saved');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('keeps the console controls synchronized and collapses Professional parameters', async () => {
    jest.doMock('./shared/settings', () => ({
      DEFAULT_EXTENSION_SETTINGS: savedSettings,
      loadExtensionSettingsFromStorage: jest.fn().mockResolvedValue(savedSettings),
      saveExtensionSettingsToStorage: jest.fn().mockResolvedValue(savedSettings),
      resetExtensionSettingsToDefaults: jest.fn().mockResolvedValue(savedSettings),
    }));

    jest.isolateModules(() => {
      require('./settings');
    });
    await Promise.resolve();

    const storage = document.querySelector<HTMLButtonElement>('[data-select="recording-mode"]')!;
    const storageLabel = storage.querySelector('.value-cycle-label');
    expect(storageLabel?.textContent).toBe('Google Drive');

    storage.click();
    expect(storage.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('recording-mode-options')?.hidden).toBe(false);
    expect((document.getElementById('recording-mode') as HTMLSelectElement).value).toBe('drive');

    (document.querySelector('[data-select="recording-mode"]') as HTMLButtonElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(storage.getAttribute('aria-expanded')).toBe('false');

    storage.click();
    (document.querySelector('#recording-mode-options [data-value="opfs"]') as HTMLButtonElement).click();
    expect((document.getElementById('recording-mode') as HTMLSelectElement).value).toBe('opfs');
    expect(storageLabel?.textContent).toBe('OPFS (Local Disk)');
    expect(storage.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('#recording-mode-options [data-value="opfs"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#recording-mode-options [data-value="drive"]')?.getAttribute('aria-selected')).toBe('false');

    const separateCamera = document.querySelector<HTMLButtonElement>('[data-checkbox="separate-camera"] [data-value="false"]')!;
    separateCamera.click();
    expect((document.getElementById('separate-camera') as HTMLInputElement).checked).toBe(false);
    expect(separateCamera.getAttribute('aria-pressed')).toBe('true');

    const professionalToggle = document.getElementById('professional-toggle') as HTMLButtonElement;
    const professionalFields = document.getElementById('professional-fields') as HTMLElement;
    professionalToggle.click();
    expect(professionalToggle.getAttribute('aria-expanded')).toBe('false');
    expect(professionalFields.hidden).toBe(true);
  });

  it('disables unavailable formats in both selectors and rejects a stale saved choice', async () => {
    (MediaRecorder.isTypeSupported as jest.Mock).mockReturnValue(false);
    const staleSettings: ExtensionSettings = {
      ...savedSettings,
      basic: { ...savedSettings.basic, microphoneRecordingFormat: 'm4a' },
    };
    const saveExtensionSettingsToStorage = jest.fn().mockResolvedValue(staleSettings);
    jest.doMock('./shared/settings', () => ({
      DEFAULT_EXTENSION_SETTINGS: savedSettings,
      loadExtensionSettingsFromStorage: jest.fn().mockResolvedValue(staleSettings),
      saveExtensionSettingsToStorage,
      resetExtensionSettingsToDefaults: jest.fn().mockResolvedValue(savedSettings),
    }));

    jest.isolateModules(() => {
      require('./settings');
    });
    await Promise.resolve();

    const m4aNative = document.querySelector<HTMLSelectElement>('#microphone-recording-format option[value="m4a"]')!;
    const m4aCustom = document.querySelector<HTMLButtonElement>('#microphone-recording-format-options [data-value="m4a"]')!;
    expect(m4aNative.disabled).toBe(true);
    expect(m4aCustom.disabled).toBe(true);
    expect(m4aCustom.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('microphone-recording-format-note')?.hidden).toBe(false);

    const trigger = document.getElementById('microphone-recording-format-trigger') as HTMLButtonElement;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('#microphone-recording-format-options [data-value="webm"]'));

    (document.getElementById('save-settings') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(saveExtensionSettingsToStorage).not.toHaveBeenCalled();
    expect(document.getElementById('status')?.textContent).toMatch(/M4A microphone format is unavailable/);
  });
});
