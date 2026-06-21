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

/** Mirrors a recording run config into the popup form controls. */
export function applyRunConfigToForm(
  elements: PopupElements,
  config: RecordingRunConfig | null
): void {
  if (!config) return;

  if (elements.storageModeSelect) {
    elements.storageModeSelect.value = config.storageMode;
  }
  if (elements.micModeSelect) {
    elements.micModeSelect.value = config.micMode;
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

  return getRunConfigOrDefault({
    storageMode: elements.storageModeSelect?.value,
    micMode: elements.micModeSelect?.value,
    recordSelfVideo,
    tabContentType,
  });
}
