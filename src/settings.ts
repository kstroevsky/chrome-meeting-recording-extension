/**
 * @context Extension settings page.
 * @role    Configure default run behavior and advanced recorder parameters.
 */

import {
  DEFAULT_EXTENSION_SETTINGS,
  loadExtensionSettingsFromStorage,
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
  type ExtensionSettings,
} from './shared/extensionSettings';

type SettingsElements = {
  recordingMode: HTMLSelectElement | null;
  micMode: HTMLSelectElement | null;
  separateCamera: HTMLInputElement | null;
  selfVideoWidthFormat: HTMLSelectElement | null;
  selfVideoHeightFormat: HTMLSelectElement | null;
  selfVideoBitrate: HTMLInputElement | null;
  selfVideoFrameRate: HTMLInputElement | null;
  selfVideoMinAdaptiveBitrate: HTMLInputElement | null;
  tabMaxWidth: HTMLInputElement | null;
  tabMaxHeight: HTMLInputElement | null;
  tabMaxFrameRate: HTMLInputElement | null;
  micEchoCancellation: HTMLInputElement | null;
  micNoiseSuppression: HTMLInputElement | null;
  micAutoGain: HTMLInputElement | null;
  chunkDefaultTimeslice: HTMLInputElement | null;
  chunkExtendedTimeslice: HTMLInputElement | null;
  saveBtn: HTMLButtonElement | null;
  resetBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
};

const el: SettingsElements = {
  recordingMode: document.getElementById('recording-mode') as HTMLSelectElement | null,
  micMode: document.getElementById('mic-mode') as HTMLSelectElement | null,
  separateCamera: document.getElementById('separate-camera') as HTMLInputElement | null,
  selfVideoWidthFormat: document.getElementById('self-video-width-format') as HTMLSelectElement | null,
  selfVideoHeightFormat: document.getElementById('self-video-height-format') as HTMLSelectElement | null,
  selfVideoBitrate: document.getElementById('self-video-bitrate') as HTMLInputElement | null,
  selfVideoFrameRate: document.getElementById('self-video-frame-rate') as HTMLInputElement | null,
  selfVideoMinAdaptiveBitrate: document.getElementById('self-video-min-adaptive-bitrate') as HTMLInputElement | null,
  tabMaxWidth: document.getElementById('tab-max-width') as HTMLInputElement | null,
  tabMaxHeight: document.getElementById('tab-max-height') as HTMLInputElement | null,
  tabMaxFrameRate: document.getElementById('tab-max-frame-rate') as HTMLInputElement | null,
  micEchoCancellation: document.getElementById('mic-echo-cancellation') as HTMLInputElement | null,
  micNoiseSuppression: document.getElementById('mic-noise-suppression') as HTMLInputElement | null,
  micAutoGain: document.getElementById('mic-auto-gain') as HTMLInputElement | null,
  chunkDefaultTimeslice: document.getElementById('chunk-default-timeslice') as HTMLInputElement | null,
  chunkExtendedTimeslice: document.getElementById('chunk-extended-timeslice') as HTMLInputElement | null,
  saveBtn: document.getElementById('save-settings') as HTMLButtonElement | null,
  resetBtn: document.getElementById('reset-settings') as HTMLButtonElement | null,
  status: document.getElementById('status') as HTMLElement | null,
};

function setStatus(text: string, isError = false) {
  if (!el.status) return;
  el.status.textContent = text;
  el.status.style.color = isError ? '#8b0000' : '#145a00';
}

function applySettings(settings: Readonly<ExtensionSettings>) {
  if (el.recordingMode) el.recordingMode.value = settings.basic.recordingMode;
  if (el.micMode) el.micMode.value = settings.basic.microphoneRecordingMode;
  if (el.separateCamera) el.separateCamera.checked = settings.basic.separateCameraCapture;
  if (el.selfVideoWidthFormat) el.selfVideoWidthFormat.value = String(settings.basic.selfVideoWidthFormat);
  if (el.selfVideoHeightFormat) el.selfVideoHeightFormat.value = String(settings.basic.selfVideoHeightFormat);
  if (el.selfVideoBitrate) el.selfVideoBitrate.value = String(settings.professional.selfVideoBitrate);
  if (el.selfVideoFrameRate) el.selfVideoFrameRate.value = String(settings.professional.selfVideoFrameRate);
  if (el.selfVideoMinAdaptiveBitrate) {
    el.selfVideoMinAdaptiveBitrate.value = String(settings.professional.selfVideoMinAdaptiveBitrate);
  }
  if (el.tabMaxWidth) el.tabMaxWidth.value = String(settings.professional.tabMaxWidth);
  if (el.tabMaxHeight) el.tabMaxHeight.value = String(settings.professional.tabMaxHeight);
  if (el.tabMaxFrameRate) el.tabMaxFrameRate.value = String(settings.professional.tabMaxFrameRate);
  if (el.micEchoCancellation) el.micEchoCancellation.checked = settings.professional.microphoneEchoCancellation;
  if (el.micNoiseSuppression) el.micNoiseSuppression.checked = settings.professional.microphoneNoiseSuppression;
  if (el.micAutoGain) el.micAutoGain.checked = settings.professional.microphoneAutoGainControl;
  if (el.chunkDefaultTimeslice) el.chunkDefaultTimeslice.value = String(settings.professional.chunkDefaultTimesliceMs);
  if (el.chunkExtendedTimeslice) el.chunkExtendedTimeslice.value = String(settings.professional.chunkExtendedTimesliceMs);
}

function readSettingsFromForm(): unknown {
  return {
    basic: {
      recordingMode: el.recordingMode?.value,
      microphoneRecordingMode: el.micMode?.value,
      separateCameraCapture: el.separateCamera?.checked,
      selfVideoWidthFormat: Number(el.selfVideoWidthFormat?.value),
      selfVideoHeightFormat: Number(el.selfVideoHeightFormat?.value),
    },
    professional: {
      selfVideoBitrate: Number(el.selfVideoBitrate?.value),
      selfVideoFrameRate: Number(el.selfVideoFrameRate?.value),
      selfVideoMinAdaptiveBitrate: Number(el.selfVideoMinAdaptiveBitrate?.value),
      tabMaxWidth: Number(el.tabMaxWidth?.value),
      tabMaxHeight: Number(el.tabMaxHeight?.value),
      tabMaxFrameRate: Number(el.tabMaxFrameRate?.value),
      microphoneEchoCancellation: !!el.micEchoCancellation?.checked,
      microphoneNoiseSuppression: !!el.micNoiseSuppression?.checked,
      microphoneAutoGainControl: !!el.micAutoGain?.checked,
      chunkDefaultTimesliceMs: Number(el.chunkDefaultTimeslice?.value),
      chunkExtendedTimesliceMs: Number(el.chunkExtendedTimeslice?.value),
    },
  };
}

async function init() {
  try {
    const stored = await loadExtensionSettingsFromStorage();
    applySettings(stored);
  } catch (error) {
    console.error('[settings] failed to load settings', error);
    applySettings(DEFAULT_EXTENSION_SETTINGS);
    setStatus('Failed to load saved settings. Using defaults.', true);
  }

  el.saveBtn?.addEventListener('click', async () => {
    try {
      const saved = await saveExtensionSettingsToStorage(readSettingsFromForm());
      applySettings(saved);
      setStatus('Saved');
    } catch (error) {
      console.error('[settings] failed to save settings', error);
      setStatus('Save failed', true);
    }
  });

  el.resetBtn?.addEventListener('click', async () => {
    try {
      const defaults = await resetExtensionSettingsToDefaults();
      applySettings(defaults);
      setStatus('Reset to defaults');
    } catch (error) {
      console.error('[settings] failed to reset settings', error);
      setStatus('Reset failed', true);
    }
  });
}

void init();

