/**
 * @file popup/controllers/PopupStateController.ts
 *
 * Manages internal popup state: active run config, warnings, upload summary
 * deduplication, and the idle-phase status line computation.
 */

import { applyRunConfigToForm, buildRunConfigFromForm } from '../popupRunConfig';
import {
  describeRecordingWarnings,
  describeRunConfig,
  STATUS_BY_PHASE,
} from '../popupStatus';
import {
  buildDefaultRunConfigFromSettings,
  loadExtensionSettingsFromStorage,
} from '../../shared/extensionSettings';
import {
  createDefaultRunConfig,
  getRunConfigOrDefault,
  normalizeSessionSnapshot,
  type RecordingPhase,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../../shared/recording';
import { sendToBackground } from '../../shared/messages';
import { formatUploadFallbackMessage } from '../popupStatus';
import type { PopupElements } from '../popupView';

export type PopupStateCallbacks = {
  onPhaseChange: (phase: RecordingPhase, session: RecordingSessionSnapshot) => void;
  onToast: (msg: string) => void;
  onAlert: (msg: string) => void;
};

export class PopupStateController {
  private activeRunConfig: RecordingRunConfig | null = createDefaultRunConfig();
  private activeWarnings: string[] = [];
  private idleDefaultRunConfig: RecordingRunConfig = createDefaultRunConfig();
  private shownUploadSummary = '';
  private lastPhase: RecordingPhase = 'idle';

  constructor(private readonly el: PopupElements, private readonly callbacks: PopupStateCallbacks) {}

  /** Loads settings-derived defaults and hydrates the live background session state. */
  async refreshInitialState() {
    try {
      const settings = await loadExtensionSettingsFromStorage();
      this.idleDefaultRunConfig = buildDefaultRunConfigFromSettings(settings);
    } catch {
      this.idleDefaultRunConfig = createDefaultRunConfig();
    }

    this.setActiveRunConfig({ ...this.idleDefaultRunConfig });

    try {
      const res = await sendToBackground({ type: 'GET_RECORDING_STATUS' });
      this.applySession(normalizeSessionSnapshot(res.session));
    } catch {
      this.callbacks.onPhaseChange('idle', normalizeSessionSnapshot(undefined));
    }
  }

  /** Applies a canonical session snapshot from background into the popup state. */
  applySession(snapshot: RecordingSessionSnapshot) {
    const prevPhase = this.lastPhase;
    this.lastPhase = snapshot.phase;
    const runConfig = snapshot.phase === 'idle'
      ? { ...this.idleDefaultRunConfig }
      : getRunConfigOrDefault(snapshot.runConfig);
    this.setActiveRunConfig(runConfig);
    this.setActiveWarnings(snapshot.warnings);
    this.callbacks.onPhaseChange(snapshot.phase, snapshot);

    if (snapshot.phase === 'failed' && snapshot.error) {
      this.callbacks.onToast(`Recording error: ${snapshot.error}`);
    }

    this.handleUploadSummary(prevPhase, snapshot.phase, snapshot.uploadSummary);
  }

  /** Builds the persistent status line text based on current phase and warnings. */
  buildPersistentStatus(phase: RecordingPhase): string {
    const warning = describeRecordingWarnings(this.activeWarnings);
    if (phase === 'idle') {
      return warning;
    }
    const run = describeRunConfig(this.activeRunConfig);
    const runSuffix = run ? ` ${run}` : '';
    const warningSuffix = warning ? ` ${warning}` : '';
    return `${STATUS_BY_PHASE[phase]}${runSuffix}${warningSuffix}`;
  }

  /** Reads the run configuration from the popup form. */
  getRunConfigFromForm(): RecordingRunConfig {
    return buildRunConfigFromForm(this.el);
  }

  getIdleDefaultRunConfig(): RecordingRunConfig {
    return this.idleDefaultRunConfig;
  }

  getActiveRunConfig(): RecordingRunConfig | null {
    return this.activeRunConfig;
  }

  private setActiveRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
    applyRunConfigToForm(this.el, config);
  }

  private setActiveWarnings(warnings?: string[]) {
    this.activeWarnings = warnings ? [...warnings] : [];
  }

  private handleUploadSummary(
    prevPhase: RecordingPhase,
    phase: RecordingPhase,
    summary?: UploadSummary
  ) {
    if (phase !== 'idle' || !summary) return;

    const key = JSON.stringify(summary);
    if (this.shownUploadSummary === key) return;
    this.shownUploadSummary = key;

    const fallbackMessage = formatUploadFallbackMessage(summary);
    if (fallbackMessage) {
      this.callbacks.onAlert(fallbackMessage);
      return;
    }

    if (prevPhase === 'uploading' && summary.uploaded.length > 0) {
      this.callbacks.onToast(`Uploaded ${summary.uploaded.length} file(s) to Google Drive`);
    }
  }
}
