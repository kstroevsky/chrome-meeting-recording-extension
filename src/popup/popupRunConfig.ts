/**
 * @file popup/popupRunConfig.ts
 *
 * Bridges popup form controls with the shared `RecordingRunConfig` domain
 * model so popup defaults and runtime defaults stay aligned.
 */

import {
  DEFAULT_RECORDING_RUN_CONFIG,
  getRunConfigOrDefault,
  type RecordingRunConfig,
} from '../shared/recording';
import type { PopupElements } from './popupView';
import {
  BUILTIN_DRIVE_PROFILE_ID,
  BUILTIN_LOCAL_PROFILE_ID,
  parseSaveToValue,
  saveToValueOf,
} from '../shared/recordingDestinations';

/** The Save to value for a run config, falling back to the built-in when its profile is not listed. */
function saveToValueFor(select: HTMLSelectElement, config: RecordingRunConfig): string {
  const builtin = config.storageMode === 'drive' ? BUILTIN_DRIVE_PROFILE_ID : BUILTIN_LOCAL_PROFILE_ID;
  const wanted = saveToValueOf(config.destinationProfileId ?? builtin);
  const listed = Array.from(select.options).some((option) => option.value === wanted && !option.disabled);
  return listed ? wanted : config.storageMode;
}

/** Mirrors a recording run config into the popup form controls. */
export function applyRunConfigToForm(
  elements: PopupElements,
  config: RecordingRunConfig | null
): void {
  if (!config) return;

  if (elements.storageModeSelect) {
    const value = saveToValueFor(elements.storageModeSelect, config);
    if (elements.storageModeSelect.value !== value) {
      elements.storageModeSelect.value = value;
      // The accessible selector is a styled mirror of this native control. Notify
      // it when a restored session/default changes the value so label, icon, and
      // selected checkmark can never disagree.
      elements.storageModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (elements.micModeSelect) {
    if (elements.micModeSelect.value !== config.micMode) {
      elements.micModeSelect.value = config.micMode;
      elements.micModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (elements.recordSelfVideoCheckbox) {
    elements.recordSelfVideoCheckbox.checked = config.recordSelfVideo;
  }
  if (elements.tabContentTypeGroup && config.tabContentType) {
    const input = elements.tabContentTypeGroup.querySelector<HTMLInputElement>(
      `input[value="${config.tabContentType}"]`
    );
    if (input) input.checked = true;
  }
}

/** Reads the current popup controls into a normalized recording run config. */
export function buildRunConfigFromForm(elements: PopupElements): RecordingRunConfig {
  const recordSelfVideo =
    elements.recordSelfVideoCheckbox?.checked ?? DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo;
  const tabContentType = elements.tabContentTypeGroup
    ?.querySelector<HTMLInputElement>('input:checked')?.value;

  // "Save to" holds a destination; the storage mode follows from it. The
  // background re-derives both from the stored profile at Start.
  const selectedStorageMode = elements.storageModeSelect?.selectedOptions[0]?.dataset.storageMode;
  const saveTo = elements.storageModeSelect
    ? parseSaveToValue(
      elements.storageModeSelect.value,
      selectedStorageMode === 'local' || selectedStorageMode === 'drive' ? selectedStorageMode : undefined,
    )
    : null;
  return getRunConfigOrDefault({
    storageMode: saveTo?.storageMode,
    ...(saveTo ? { destinationProfileId: saveTo.profileId } : {}),
    micMode: elements.micModeSelect?.value,
    recordSelfVideo,
    tabContentType,
  });
}
