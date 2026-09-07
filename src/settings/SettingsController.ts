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
  MAX_DRIVE_FOLDER_NAME_LENGTH,
  MAX_LOCAL_FOLDER_PRESETS,
  MAX_LOCAL_FOLDER_NAME_LENGTH,
  MAX_DRIVE_FOLDER_PRESETS,
  loadExtensionSettingsFromStorage,
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
  type ExtensionSettings,
} from '../shared/settings';
import { getRecordingFormatCapabilities, type RecordingFormatCapabilities } from '../shared/recordingFormats';
import { applyThemePreference } from '../shared/theme';
import { FolderPresetList } from './FolderPresetList';
import { formatBytes } from '../shared/format';
import { sendToBackground } from '../shared/messages';
import { ensurePersistentStorage } from '../background/storageDurability';

export type SettingsElements = {
  anonymousDiagnostics: HTMLInputElement | null;
  theme: HTMLSelectElement | null;
  recordingMode: HTMLSelectElement | null;
  micMode: HTMLSelectElement | null;
  separateCamera: HTMLInputElement | null;
  tabRecordingFormat?: HTMLSelectElement | null;
  cameraRecordingFormat?: HTMLSelectElement | null;
  microphoneRecordingFormat?: HTMLSelectElement | null;
  selfVideoResolutionPreset: HTMLSelectElement | null;
  selfVideoAutoResolution: HTMLInputElement | null;
  selfVideoFrameRate: HTMLInputElement | null;
  tabContentType: HTMLSelectElement | null;
  tabResolutionPreset: HTMLSelectElement | null;
  tabMaxFrameRate: HTMLInputElement | null;
  destinationsList?: HTMLElement | null;
  destinationAdd?: HTMLButtonElement | null;
  destinationsNote?: HTMLElement | null;
  localFoldersList?: HTMLElement | null;
  localFolderAdd?: HTMLButtonElement | null;
  localFoldersNote?: HTMLElement | null;
  storageUsage?: HTMLElement | null;
  micEchoCancellation: HTMLInputElement | null;
  micNoiseSuppression: HTMLInputElement | null;
  micAutoGain: HTMLInputElement | null;
  chunkDefaultTimeslice: HTMLInputElement | null;
  chunkExtendedTimeslice: HTMLInputElement | null;
  themeCycle: HTMLButtonElement | null;
  professionalToggle: HTMLButtonElement | null;
  professionalFields: HTMLElement | null;
  professionalSummary: HTMLElement | null;
  saveBtn: HTMLButtonElement | null;
  resetBtn: HTMLButtonElement | null;
  status: HTMLElement | null;
};

type SettingsDocument = Document & {
  __recorderSettingsSelectAbortController__?: AbortController;
};

export class SettingsController {
  private readonly formatCapabilities: RecordingFormatCapabilities = getRecordingFormatCapabilities();
  /**
   * Reports what the retained library costs, and whether it is safe from
   * eviction. Read once on open rather than watched: it changes when a
   * recording is made, not while this page is sitting there.
   */
  private async showStorageUsage(): Promise<void> {
    const target = this.el.storageUsage;
    if (!target) return;
    try {
      // Asked again from a document. The service worker asks at startup, but a
      // worker is not a browsing context and Chrome may decline it there; this
      // page is a real one, so it is the better place to be granted.
      await ensurePersistentStorage(() => {}, () => {});
      const response = await sendToBackground({ type: 'GET_STORAGE_USAGE' });
      if (!response.ok) throw new Error(response.error);
      const { retainedBytes, usageBytes, quotaBytes, persisted } = response.usage;
      const detail = usageBytes != null && quotaBytes != null
        ? `${formatBytes(usageBytes)} of ${formatBytes(quotaBytes)} used by this extension in total`
        : 'Total usage is unavailable in this browser';
      target.textContent = formatBytes(retainedBytes);
      const small = document.createElement('small');
      small.textContent = detail;
      target.append(small);
      // Never surfaced. `unlimitedStorage` is what exempts this extension's
      // storage from eviction; the StorageManager grant is a different
      // mechanism and reads false here regardless, so showing it would imply a
      // risk that does not exist.
      void persisted;
    } catch {
      target.textContent = 'Unavailable';
    }
  }

  /**
   * Two lists, edited in memory and written on save like every other control.
   * Ids are minted once and never reused, so renaming a folder cannot silently
   * re-target the recordings that chose it.
   */
  private readonly driveFolders: FolderPresetList;
  private readonly localFolders: FolderPresetList;

  constructor(private readonly el: SettingsElements) {
    this.driveFolders = new FolderPresetList({
      elements: { list: el.destinationsList, add: el.destinationAdd, note: el.destinationsNote },
      maxPresets: MAX_DRIVE_FOLDER_PRESETS,
      maxNameLength: MAX_DRIVE_FOLDER_NAME_LENGTH,
      placeholder: 'e.g. Work meetings',
      noun: 'Destination',
      idPrefix: 'dest',
    });
    this.localFolders = new FolderPresetList({
      elements: { list: el.localFoldersList, add: el.localFolderAdd, note: el.localFoldersNote },
      maxPresets: MAX_LOCAL_FOLDER_PRESETS,
      maxNameLength: MAX_LOCAL_FOLDER_NAME_LENGTH,
      placeholder: 'e.g. Therapy 2026',
      noun: 'Folder',
      idPrefix: 'local',
    });
  }

  /** Loads saved settings into the form and wires save/reset + the tooltip controller. */
  async init(): Promise<void> {
    this.wireConsoleControls();
    this.driveFolders.wire();
    this.localFolders.wire();
    void this.showStorageUsage();

    try {
      const stored = await loadExtensionSettingsFromStorage();
      this.applySettings(stored);
    } catch (error) {
      console.error('[settings] failed to load settings', error);
      this.applySettings(DEFAULT_EXTENSION_SETTINGS);
      this.setStatus('Failed to load saved settings. Using defaults.', true);
    }
    this.applyFormatCapabilities();

    this.el.saveBtn?.addEventListener('click', async () => {
      const unavailable = this.selectedUnsupportedFormat();
      if (unavailable) {
        this.setStatus(`${unavailable} is unavailable in this browser. Select WebM instead.`, true);
        return;
      }
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
    this.el.status.style.color = isError ? 'var(--error)' : 'var(--success)';
  }

  /** Mirrors normalized settings into the current form controls. */
  private applySettings(settings: Readonly<ExtensionSettings>): void {
    const el = this.el;
    // Repainted here rather than only at load, so "Reset to defaults" actually
    // clears the lists instead of leaving rows the reset just erased.
    this.driveFolders.apply(settings.storage.driveFolderPresets);
    this.localFolders.apply(settings.storage.localFolderPresets);
    if (el.anonymousDiagnostics) el.anonymousDiagnostics.checked = settings.privacy.anonymousDiagnostics;
    if (el.theme) el.theme.value = settings.appearance.theme;
    applyThemePreference(settings.appearance.theme);
    if (el.recordingMode) el.recordingMode.value = settings.basic.recordingMode;
    if (el.micMode) el.micMode.value = settings.basic.microphoneRecordingMode;
    if (el.separateCamera) el.separateCamera.checked = settings.basic.separateCameraCapture;
    if (el.tabRecordingFormat) el.tabRecordingFormat.value = settings.basic.tabRecordingFormat;
    if (el.cameraRecordingFormat) el.cameraRecordingFormat.value = settings.basic.cameraRecordingFormat;
    if (el.microphoneRecordingFormat) el.microphoneRecordingFormat.value = settings.basic.microphoneRecordingFormat;
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
    this.syncConsoleControls();
  }

  /** Reads the current form state into the storage payload expected by settings normalization. */
  private readSettingsFromForm(): unknown {
    const el = this.el;
    return {
      privacy: {
        anonymousDiagnostics: el.anonymousDiagnostics?.checked !== false,
      },
      appearance: {
        theme: el.theme?.value,
      },
      basic: {
        recordingMode: el.recordingMode?.value,
        microphoneRecordingMode: el.micMode?.value,
        separateCameraCapture: el.separateCamera?.checked,
        tabRecordingFormat: el.tabRecordingFormat?.value,
        cameraRecordingFormat: el.cameraRecordingFormat?.value,
        microphoneRecordingFormat: el.microphoneRecordingFormat?.value,
        selfVideoResolutionPreset: el.selfVideoResolutionPreset?.value,
        selfVideoUseAutoResolution: !!el.selfVideoAutoResolution?.checked,
      },
      storage: {
        driveFolderPresets: this.driveFolders.read(),
        localFolderPresets: this.localFolders.read(),
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




  /** Disables native and custom-selector options unavailable in this Chromium build. */
  private applyFormatCapabilities(): void {
    this.setFormatAvailability(
      'tab-recording-format',
      'mp4',
      this.formatCapabilities.tabMp4,
      'MP4 tab recording is unavailable in this browser.'
    );
    this.setFormatAvailability(
      'camera-recording-format',
      'mp4',
      this.formatCapabilities.cameraMp4,
      'MP4 camera recording is unavailable in this browser.'
    );
    this.setFormatAvailability(
      'microphone-recording-format',
      'm4a',
      this.formatCapabilities.microphoneM4a,
      'M4A/AAC microphone recording is unavailable in this browser.'
    );
    this.syncConsoleControls();
  }

  private setFormatAvailability(selectId: string, value: string, available: boolean, message: string): void {
    const select = document.getElementById(selectId) as HTMLSelectElement | null;
    const nativeOption = Array.from(select?.options ?? []).find((option) => option.value === value);
    if (nativeOption) nativeOption.disabled = !available;

    const selectorOptions = document.getElementById(`${selectId}-options`);
    const customOption = selectorOptions?.querySelector<HTMLButtonElement>(`[role="option"][data-value="${value}"]`);
    if (customOption) {
      customOption.disabled = !available;
      customOption.setAttribute('aria-disabled', String(!available));
      customOption.title = available ? '' : message;
    }

    const note = document.getElementById(`${selectId}-note`);
    if (note) {
      note.textContent = available ? '' : message;
      note.hidden = available;
    }
  }

  private selectedUnsupportedFormat(): string | null {
    if (this.el.tabRecordingFormat?.value === 'mp4' && !this.formatCapabilities.tabMp4) return 'MP4 tab format';
    if (this.el.cameraRecordingFormat?.value === 'mp4' && !this.formatCapabilities.cameraMp4) return 'MP4 camera format';
    if (this.el.microphoneRecordingFormat?.value === 'm4a' && !this.formatCapabilities.microphoneM4a) return 'M4A microphone format';
    return null;
  }

  /** Wires the reference console controls to the existing form fields. */
  private wireConsoleControls(): void {
    this.el.themeCycle?.addEventListener('click', () => {
      this.cycleSelect(this.el.theme);
      if (this.el.theme) applyThemePreference(this.el.theme.value as ExtensionSettings['appearance']['theme']);
      this.syncConsoleControls();
    });

    this.wireSelectControls();

    document.querySelectorAll<HTMLElement>('[data-checkbox]').forEach((control) => {
      control.addEventListener('click', (event) => {
        const target = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-value]');
        const input = document.getElementById(control.dataset.checkbox ?? '') as HTMLInputElement | null;
        if (!target || !input) return;
        input.checked = target.dataset.value === 'true';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    this.el.professionalToggle?.addEventListener('click', () => {
      const isOpen = this.el.professionalToggle?.getAttribute('aria-expanded') === 'true';
      this.setProfessionalOpen(!isOpen);
    });

    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((control) => {
      control.addEventListener('change', () => {
        if (control === this.el.theme) applyThemePreference(control.value as ExtensionSettings['appearance']['theme']);
        this.syncConsoleControls();
      });
    });
  }

  /** Advances the titlebar theme control and emits its normal change event. */
  private cycleSelect(select: HTMLSelectElement | null): void {
    if (!select || select.options.length === 0) return;
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Wires popup-style listboxes to the form-backed settings selects. */
  private wireSelectControls(): void {
    const settingsDocument = document as SettingsDocument;
    settingsDocument.__recorderSettingsSelectAbortController__?.abort();
    const abortController = new AbortController();
    settingsDocument.__recorderSettingsSelectAbortController__ = abortController;
    const listenerOptions = { signal: abortController.signal };
    const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-select]'));
    const close = (trigger: HTMLButtonElement) => {
      const optionsId = trigger.getAttribute('aria-controls');
      const options = optionsId ? document.getElementById(optionsId) : null;
      if (options) options.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    const closeAll = (except?: HTMLButtonElement) => {
      triggers.forEach((trigger) => {
        if (trigger !== except) close(trigger);
      });
    };
    const optionsFor = (trigger: HTMLButtonElement): HTMLElement | null => {
      const optionsId = trigger.getAttribute('aria-controls');
      return optionsId ? document.getElementById(optionsId) : null;
    };
    const choose = (trigger: HTMLButtonElement, value: string) => {
      const select = document.getElementById(trigger.dataset.select ?? '') as HTMLSelectElement | null;
      if (!select) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      this.syncConsoleControls();
      close(trigger);
      trigger.focus();
    };
    const selectableOptions = (options: HTMLElement) =>
      Array.from(options.querySelectorAll<HTMLButtonElement>('[role="option"]')).filter((item) => !item.disabled);
    const focusOption = (options: HTMLElement, index: number) => {
      const items = selectableOptions(options);
      items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
    };
    const open = (trigger: HTMLButtonElement, initialOffset = 0) => {
      const options = optionsFor(trigger);
      if (!options) return;
      closeAll(trigger);
      options.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const selected = selectableOptions(options)
        .findIndex((option) => option.getAttribute('aria-selected') === 'true');
      focusOption(options, selected + initialOffset);
    };

    triggers.forEach((trigger) => {
      const options = optionsFor(trigger);
      if (!options) return;
      trigger.addEventListener('click', () => {
        if (options.hidden) open(trigger);
        else close(trigger);
      });
      trigger.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          open(trigger, event.key === 'ArrowDown' ? 0 : -1);
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          open(trigger, event.key === 'Home' ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
        }
      });
      options.addEventListener('click', (event) => {
        const option = (event.target as Element | null)?.closest<HTMLButtonElement>('[role="option"]');
        if (option?.dataset.value && !option.disabled) choose(trigger, option.dataset.value);
      });
      options.addEventListener('keydown', (event) => {
        const items = selectableOptions(options);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusOption(options, index + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          focusOption(options, event.key === 'Home' ? 0 : items.length - 1);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close(trigger);
          trigger.focus();
        }
      });
    });

    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      triggers.forEach((trigger) => {
        const options = optionsFor(trigger);
        if (options && !options.hidden && !trigger.contains(target) && !options.contains(target)) close(trigger);
      });
    }, listenerOptions);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAll();
    }, listenerOptions);
  }

  /** Synchronizes the visual console controls with their form-backed values. */
  private syncConsoleControls(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach((control) => {
      const select = document.getElementById(control.dataset.select ?? '') as HTMLSelectElement | null;
      const label = control.querySelector<HTMLElement>('.value-cycle-label');
      if (!select || !label) return;
      label.textContent = select.options[select.selectedIndex]?.textContent?.trim() ?? '';
      control.title = label.textContent;
      const optionsId = control.getAttribute('aria-controls');
      const options = optionsId ? document.getElementById(optionsId) : null;
      options?.querySelectorAll<HTMLButtonElement>('[role="option"]').forEach((option) => {
        option.setAttribute('aria-selected', String(option.dataset.value === select.value));
      });
      if (control.dataset.select === 'recording-mode' && options) {
        const selectedIcon = options.querySelector<SVGElement>(`[role="option"][data-value="${select.value}"] .select-option-icon`);
        const currentIcon = control.querySelector<SVGElement>('.storage-icon');
        if (selectedIcon && currentIcon) {
          const icon = selectedIcon.cloneNode(true) as SVGElement;
          icon.classList.replace('select-option-icon', 'storage-icon');
          currentIcon.replaceWith(icon);
        }
      }
    });

    document.querySelectorAll<HTMLElement>('[data-checkbox]').forEach((control) => {
      const input = document.getElementById(control.dataset.checkbox ?? '') as HTMLInputElement | null;
      if (!input) return;
      control.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((button) => {
        button.setAttribute('aria-pressed', String((button.dataset.value === 'true') === input.checked));
      });
    });

    const settings = this.readSettingsFromForm() as ExtensionSettings;
    const tabResolution = settings.professional.tabResolutionPreset.split('x')[1] ?? '';
    const tabType = settings.professional.tabContentType === 'video' ? 'VIDEO' : 'TEXT';
    const dsp = settings.professional.microphoneEchoCancellation
      && settings.professional.microphoneNoiseSuppression
      && settings.professional.microphoneAutoGainControl
      ? 'DSP ON'
      : !settings.professional.microphoneEchoCancellation
        && !settings.professional.microphoneNoiseSuppression
        && !settings.professional.microphoneAutoGainControl
        ? 'DSP OFF'
        : 'DSP CUSTOM';
    if (this.el.professionalSummary) {
      this.el.professionalSummary.textContent = `CAM ${settings.professional.selfVideoFrameRate}FPS · TAB ${tabType} ${tabResolution}P @${settings.professional.tabMaxFrameRate}FPS · ${dsp}`;
    }
    if (this.el.themeCycle && this.el.theme) {
      this.el.themeCycle.setAttribute('aria-label', `Theme: ${this.el.theme.value}. Click to cycle theme.`);
      this.el.themeCycle.title = `Theme: ${this.el.theme.value}. Click to cycle theme.`;
    }
  }

  /** Opens or closes the Professional rows without disturbing the settings values. */
  private setProfessionalOpen(open: boolean): void {
    this.el.professionalToggle?.setAttribute('aria-expanded', String(open));
    if (this.el.professionalFields) this.el.professionalFields.hidden = !open;
  }
}

/** Ids only need to be unique within one user's settings. */
