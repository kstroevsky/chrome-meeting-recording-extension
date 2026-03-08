/**
 * @file popup/popupRunConfig.ts
 *
 * Bridges popup form controls with the shared `RecordingRunConfig` domain
 * model so popup defaults and runtime defaults stay aligned.
 */

import {
  createDefaultRunConfig,
  normalizeMicMode,
  normalizeRunConfig,
  type RecordingRunConfig,
} from '../shared/recording';
import type { PopupElements } from './popupView';

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
  if (elements.selfVideoHighQualityCheckbox) {
    elements.selfVideoHighQualityCheckbox.checked = config.selfVideoQuality === 'high';
  }
}

export function buildRunConfigFromForm(elements: PopupElements): RecordingRunConfig {
  const defaults = createDefaultRunConfig();
  const recordSelfVideo = elements.recordSelfVideoCheckbox?.checked ?? defaults.recordSelfVideo;
  const selfVideoQuality =
    recordSelfVideo && elements.selfVideoHighQualityCheckbox?.checked
      ? 'high'
      : defaults.selfVideoQuality;

  return normalizeRunConfig({
    storageMode: elements.storageModeSelect?.value,
    micMode: normalizeMicMode(elements.micModeSelect?.value),
    recordSelfVideo,
    selfVideoQuality,
  }) ?? defaults;
}
