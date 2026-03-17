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
  selfVideoResolutionPreset: HTMLSelectElement | null;
  selfVideoBitrate: HTMLInputElement | null;
  selfVideoFrameRate: HTMLInputElement | null;
  selfVideoMinAdaptiveBitrate: HTMLInputElement | null;
  tabResolutionPreset: HTMLSelectElement | null;
  tabMaxFrameRate: HTMLInputElement | null;
  tabResizePostprocess: HTMLInputElement | null;
  tabMp4Output: HTMLInputElement | null;
  selfVideoMp4Output: HTMLInputElement | null;
  micEchoCancellation: HTMLInputElement | null;
  micNoiseSuppression: HTMLInputElement | null;
  micAutoGain: HTMLInputElement | null;
  chunkDefaultTimeslice: HTMLInputElement | null;
  chunkExtendedTimeslice: HTMLInputElement | null;
  saveBtn: HTMLButtonElement | null;
  resetBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
};

type SettingsDocument = Document & {
  __recorderSettingsTooltipControllerBound__?: boolean;
};

const TOOLTIP_TOGGLE_SELECTOR = '.tooltip-toggle';

const el: SettingsElements = {
  recordingMode: document.getElementById('recording-mode') as HTMLSelectElement | null,
  micMode: document.getElementById('mic-mode') as HTMLSelectElement | null,
  separateCamera: document.getElementById('separate-camera') as HTMLInputElement | null,
  selfVideoResolutionPreset: document.getElementById('self-video-resolution-preset') as HTMLSelectElement | null,
  selfVideoBitrate: document.getElementById('self-video-bitrate') as HTMLInputElement | null,
  selfVideoFrameRate: document.getElementById('self-video-frame-rate') as HTMLInputElement | null,
  selfVideoMinAdaptiveBitrate: document.getElementById('self-video-min-adaptive-bitrate') as HTMLInputElement | null,
  tabResolutionPreset: document.getElementById('tab-resolution-preset') as HTMLSelectElement | null,
  tabMaxFrameRate: document.getElementById('tab-max-frame-rate') as HTMLInputElement | null,
  tabResizePostprocess: document.getElementById('tab-resize-postprocess') as HTMLInputElement | null,
  tabMp4Output: document.getElementById('tab-mp4-output') as HTMLInputElement | null,
  selfVideoMp4Output: document.getElementById('self-video-mp4-output') as HTMLInputElement | null,
  micEchoCancellation: document.getElementById('mic-echo-cancellation') as HTMLInputElement | null,
  micNoiseSuppression: document.getElementById('mic-noise-suppression') as HTMLInputElement | null,
  micAutoGain: document.getElementById('mic-auto-gain') as HTMLInputElement | null,
  chunkDefaultTimeslice: document.getElementById('chunk-default-timeslice') as HTMLInputElement | null,
  chunkExtendedTimeslice: document.getElementById('chunk-extended-timeslice') as HTMLInputElement | null,
  saveBtn: document.getElementById('save-settings') as HTMLButtonElement | null,
  resetBtn: document.getElementById('reset-settings') as HTMLButtonElement | null,
  status: document.getElementById('status') as HTMLElement | null,
};

/** Updates the inline page status message after load/save/reset actions. */
function setStatus(text: string, isError = false): void {
  if (!el.status) return;
  el.status.textContent = text;
  el.status.style.color = isError ? '#8b0000' : '#145a00';
}

/** Mirrors normalized settings into the current form controls. */
function applySettings(settings: Readonly<ExtensionSettings>): void {
  if (el.recordingMode) el.recordingMode.value = settings.basic.recordingMode;
  if (el.micMode) el.micMode.value = settings.basic.microphoneRecordingMode;
  if (el.separateCamera) el.separateCamera.checked = settings.basic.separateCameraCapture;
  if (el.selfVideoResolutionPreset) {
    el.selfVideoResolutionPreset.value = settings.basic.selfVideoResolutionPreset;
  }
  if (el.selfVideoBitrate) el.selfVideoBitrate.value = String(settings.professional.selfVideoBitrate);
  if (el.selfVideoFrameRate) el.selfVideoFrameRate.value = String(settings.professional.selfVideoFrameRate);
  if (el.selfVideoMinAdaptiveBitrate) {
    el.selfVideoMinAdaptiveBitrate.value = String(settings.professional.selfVideoMinAdaptiveBitrate);
  }
  if (el.tabResolutionPreset) {
    el.tabResolutionPreset.value = settings.professional.tabResolutionPreset;
  }
  if (el.tabMaxFrameRate) el.tabMaxFrameRate.value = String(settings.professional.tabMaxFrameRate);
  if (el.tabResizePostprocess) el.tabResizePostprocess.checked = settings.professional.tabResizePostprocess;
  if (el.tabMp4Output) el.tabMp4Output.checked = settings.professional.tabMp4Output;
  if (el.selfVideoMp4Output) el.selfVideoMp4Output.checked = settings.professional.selfVideoMp4Output;
  if (el.micEchoCancellation) el.micEchoCancellation.checked = settings.professional.microphoneEchoCancellation;
  if (el.micNoiseSuppression) el.micNoiseSuppression.checked = settings.professional.microphoneNoiseSuppression;
  if (el.micAutoGain) el.micAutoGain.checked = settings.professional.microphoneAutoGainControl;
  if (el.chunkDefaultTimeslice) el.chunkDefaultTimeslice.value = String(settings.professional.chunkDefaultTimesliceMs);
  if (el.chunkExtendedTimeslice) el.chunkExtendedTimeslice.value = String(settings.professional.chunkExtendedTimesliceMs);
}

/** Reads the current form state into the storage payload expected by settings normalization. */
function readSettingsFromForm(): unknown {
  return {
    basic: {
      recordingMode: el.recordingMode?.value,
      microphoneRecordingMode: el.micMode?.value,
      separateCameraCapture: el.separateCamera?.checked,
      selfVideoResolutionPreset: el.selfVideoResolutionPreset?.value,
    },
    professional: {
      selfVideoBitrate: Number(el.selfVideoBitrate?.value),
      selfVideoFrameRate: Number(el.selfVideoFrameRate?.value),
      selfVideoMinAdaptiveBitrate: Number(el.selfVideoMinAdaptiveBitrate?.value),
      tabResolutionPreset: el.tabResolutionPreset?.value,
      tabMaxFrameRate: Number(el.tabMaxFrameRate?.value),
      tabResizePostprocess: !!el.tabResizePostprocess?.checked,
      tabMp4Output: !!el.tabMp4Output?.checked,
      selfVideoMp4Output: !!el.selfVideoMp4Output?.checked,
      microphoneEchoCancellation: !!el.micEchoCancellation?.checked,
      microphoneNoiseSuppression: !!el.micNoiseSuppression?.checked,
      microphoneAutoGainControl: !!el.micAutoGain?.checked,
      chunkDefaultTimesliceMs: Number(el.chunkDefaultTimeslice?.value),
      chunkExtendedTimesliceMs: Number(el.chunkExtendedTimeslice?.value),
    },
  };
}

/** Resolves the tooltip bubble controlled by a given icon button. */
function getTooltipBubble(toggle: HTMLButtonElement): HTMLElement | null {
  const tooltipId = toggle.getAttribute('aria-controls');
  return tooltipId ? document.getElementById(tooltipId) : null;
}

/** Opens or closes one tooltip bubble and keeps ARIA state in sync. */
function setTooltipOpen(toggle: HTMLButtonElement, open: boolean): void {
  const bubble = getTooltipBubble(toggle);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!bubble) return;
  bubble.hidden = !open;
}

/** Closes every currently open tooltip except an optional active toggle. */
function closeOpenTooltips(except?: HTMLButtonElement): void {
  document.querySelectorAll<HTMLButtonElement>(`${TOOLTIP_TOGGLE_SELECTOR}[aria-expanded="true"]`)
    .forEach((toggle) => {
      if (toggle === except) return;
      setTooltipOpen(toggle, false);
    });
}

/** Wires a single delegated tooltip controller for the entire settings page. */
function wireTooltipController(): void {
  const settingsDocument = document as SettingsDocument;
  if (settingsDocument.__recorderSettingsTooltipControllerBound__) return;
  settingsDocument.__recorderSettingsTooltipControllerBound__ = true;

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const toggle = target.closest(TOOLTIP_TOGGLE_SELECTOR) as HTMLButtonElement | null;
    if (toggle) {
      event.preventDefault();
      const shouldOpen = toggle.getAttribute('aria-expanded') !== 'true';
      closeOpenTooltips(toggle);
      setTooltipOpen(toggle, shouldOpen);
      return;
    }

    if (target.closest('.tooltip-shell')) return;
    closeOpenTooltips();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeOpenTooltips();
  });
}

/** Loads saved settings and wires all page interactions. */
async function init(): Promise<void> {
  wireTooltipController();

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
