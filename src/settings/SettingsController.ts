/**
 * @file settings/SettingsController.ts
 *
 * Owns all settings-page interaction: load saved settings → apply to the form,
 * save/reset, page status, and the single delegated tooltip controller. The
 * `settings.ts` entry is a thin shell that queries the DOM and hands the elements
 * here — mirroring `popup.ts → PopupController` and `debug.ts → DebugDashboard`.
 */

import {
  DEFAULT_EXTENSION_SETTINGS,
  loadExtensionSettingsFromStorage,
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
  type ExtensionSettings,
} from '../shared/settings';

export type SettingsElements = {
  recordingMode: HTMLSelectElement | null;
  micMode: HTMLSelectElement | null;
  separateCamera: HTMLInputElement | null;
  selfVideoResolutionPreset: HTMLSelectElement | null;
  selfVideoAutoResolution: HTMLInputElement | null;
  selfVideoFrameRate: HTMLInputElement | null;
  tabContentType: HTMLSelectElement | null;
  tabResolutionPreset: HTMLSelectElement | null;
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

type SettingsDocument = Document & {
  __recorderSettingsTooltipControllerBound__?: boolean;
};

const TOOLTIP_TOGGLE_SELECTOR = '.tooltip-toggle';

export class SettingsController {
  constructor(private readonly el: SettingsElements) {}

  /** Loads saved settings into the form and wires save/reset + the tooltip controller. */
  async init(): Promise<void> {
    this.wireTooltipController();

    try {
      const stored = await loadExtensionSettingsFromStorage();
      this.applySettings(stored);
    } catch (error) {
      console.error('[settings] failed to load settings', error);
      this.applySettings(DEFAULT_EXTENSION_SETTINGS);
      this.setStatus('Failed to load saved settings. Using defaults.', true);
    }

    this.el.saveBtn?.addEventListener('click', async () => {
      try {
        const saved = await saveExtensionSettingsToStorage(this.readSettingsFromForm());
        this.applySettings(saved);
        this.setStatus('Saved');
      } catch (error) {
        console.error('[settings] failed to save settings', error);
        this.setStatus('Save failed', true);
      }
    });

    this.el.resetBtn?.addEventListener('click', async () => {
      try {
        const defaults = await resetExtensionSettingsToDefaults();
        this.applySettings(defaults);
        this.setStatus('Reset to defaults');
      } catch (error) {
        console.error('[settings] failed to reset settings', error);
        this.setStatus('Reset failed', true);
      }
    });
  }

  /** Updates the inline page status message after load/save/reset actions. */
  private setStatus(text: string, isError = false): void {
    if (!this.el.status) return;
    this.el.status.textContent = text;
    this.el.status.style.color = isError ? '#8b0000' : '#145a00';
  }

  /** Mirrors normalized settings into the current form controls. */
  private applySettings(settings: Readonly<ExtensionSettings>): void {
    const el = this.el;
    if (el.recordingMode) el.recordingMode.value = settings.basic.recordingMode;
    if (el.micMode) el.micMode.value = settings.basic.microphoneRecordingMode;
    if (el.separateCamera) el.separateCamera.checked = settings.basic.separateCameraCapture;
    if (el.selfVideoResolutionPreset) {
      el.selfVideoResolutionPreset.value = settings.basic.selfVideoResolutionPreset;
    }
    if (el.selfVideoAutoResolution) {
      el.selfVideoAutoResolution.checked = settings.basic.selfVideoUseAutoResolution;
    }
    if (el.selfVideoFrameRate) el.selfVideoFrameRate.value = String(settings.professional.selfVideoFrameRate);
    if (el.tabContentType) el.tabContentType.value = settings.professional.tabContentType;
    if (el.tabResolutionPreset) {
      el.tabResolutionPreset.value = settings.professional.tabResolutionPreset;
    }
    if (el.tabMaxFrameRate) el.tabMaxFrameRate.value = String(settings.professional.tabMaxFrameRate);
    if (el.micEchoCancellation) el.micEchoCancellation.checked = settings.professional.microphoneEchoCancellation;
    if (el.micNoiseSuppression) el.micNoiseSuppression.checked = settings.professional.microphoneNoiseSuppression;
    if (el.micAutoGain) el.micAutoGain.checked = settings.professional.microphoneAutoGainControl;
    if (el.chunkDefaultTimeslice) el.chunkDefaultTimeslice.value = String(settings.professional.chunkDefaultTimesliceMs);
    if (el.chunkExtendedTimeslice) el.chunkExtendedTimeslice.value = String(settings.professional.chunkExtendedTimesliceMs);
  }

  /** Reads the current form state into the storage payload expected by settings normalization. */
  private readSettingsFromForm(): unknown {
    const el = this.el;
    return {
      basic: {
        recordingMode: el.recordingMode?.value,
        microphoneRecordingMode: el.micMode?.value,
        separateCameraCapture: el.separateCamera?.checked,
        selfVideoResolutionPreset: el.selfVideoResolutionPreset?.value,
        selfVideoUseAutoResolution: !!el.selfVideoAutoResolution?.checked,
      },
      professional: {
        selfVideoFrameRate: Number(el.selfVideoFrameRate?.value),
        tabContentType: el.tabContentType?.value,
        tabResolutionPreset: el.tabResolutionPreset?.value,
        tabMaxFrameRate: Number(el.tabMaxFrameRate?.value),
        microphoneEchoCancellation: !!el.micEchoCancellation?.checked,
        microphoneNoiseSuppression: !!el.micNoiseSuppression?.checked,
        microphoneAutoGainControl: !!el.micAutoGain?.checked,
        chunkDefaultTimesliceMs: Number(el.chunkDefaultTimeslice?.value),
        chunkExtendedTimesliceMs: Number(el.chunkExtendedTimeslice?.value),
      },
    };
  }

  /** Resolves the tooltip bubble controlled by a given icon button. */
  private getTooltipBubble(toggle: HTMLButtonElement): HTMLElement | null {
    const tooltipId = toggle.getAttribute('aria-controls');
    return tooltipId ? document.getElementById(tooltipId) : null;
  }

  /** Opens or closes one tooltip bubble and keeps ARIA state in sync. */
  private setTooltipOpen(toggle: HTMLButtonElement, open: boolean): void {
    const bubble = this.getTooltipBubble(toggle);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!bubble) return;
    bubble.hidden = !open;
  }

  /** Closes every currently open tooltip except an optional active toggle. */
  private closeOpenTooltips(except?: HTMLButtonElement): void {
    document.querySelectorAll<HTMLButtonElement>(`${TOOLTIP_TOGGLE_SELECTOR}[aria-expanded="true"]`)
      .forEach((toggle) => {
        if (toggle === except) return;
        this.setTooltipOpen(toggle, false);
      });
  }

  /** Wires a single delegated tooltip controller for the entire settings page. */
  private wireTooltipController(): void {
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
        this.closeOpenTooltips(toggle);
        this.setTooltipOpen(toggle, shouldOpen);
        return;
      }

      if (target.closest('.tooltip-shell')) return;
      this.closeOpenTooltips();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeOpenTooltips();
    });
  }
}
