import { addStorageChangedListener } from '../../../platform/chrome/storage';
import { loadExtensionSettingsFromStorage, normalizeExtensionSettings } from '../../../shared/settings';
import type { RecordingRunConfig, UploadJob } from '../../../shared/recording';
import type { RecorderRuntimeSettingsSnapshot } from '../../../shared/settings';
import {
  TelemetryAccumulator,
  TelemetryCoordinator,
  createTelemetryId,
  recordingContextFromRunConfig,
  type TelemetryIncidentInput,
  type TelemetrySink,
  type TelemetrySnapshot,
} from '../../../shared/telemetry';

export class TelemetryRuntime {
  private readonly coordinator = new TelemetryCoordinator();
  private accumulator: TelemetryAccumulator | null = null;
  // Fail closed until persisted privacy settings are hydrated. The default-on
  // migration is applied by normalizeExtensionSettings during initialize().
  private enabled = false;
  private runId: string | null = null;

  async initialize(liveEpochs = new Set<number>(), liveUploadJobIds = new Set<string>()): Promise<void> {
    const settings = await loadExtensionSettingsFromStorage();
    this.setEnabled(settings.privacy.anonymousDiagnostics);
    addStorageChangedListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.extensionSettings) return;
      this.setEnabled(normalizeExtensionSettings(changes.extensionSettings.newValue).privacy.anonymousDiagnostics);
    });
    if (this.enabled && typeof indexedDB === 'undefined') this.setEnabled(false);
    if (this.enabled) await this.coordinator.recover(liveEpochs, liveUploadJobIds);
    chrome.alarms?.onAlarm?.addListener((alarm) => {
      if (alarm.name === 'anonymous-telemetry-retry') void this.coordinator.deliverPending();
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.coordinator.setEnabled(enabled);
    if (!enabled) { this.accumulator?.reset(); this.accumulator = null; this.runId = null; }
    if (!enabled) {
      void chrome.tabs?.query?.({}).then((tabs) => Promise.all(tabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => chrome.tabs.sendMessage(tab.id!, { type: 'TELEMETRY_RUN', runId: null, enabled: false }).catch(() => {}))))
        .catch(() => {});
    }
  }

  start(runConfig: RecordingRunConfig, recorderSettings?: RecorderRuntimeSettingsSnapshot, epoch?: number): string {
    const runId = createTelemetryId();
    this.runId = runId;
    if (!this.enabled) return runId;
    this.coordinator.startRun(runId, recordingContextFromRunConfig(runConfig, recorderSettings), epoch);
    this.accumulator = new TelemetryAccumulator(runId, 'background', {
      onCheckpoint: (snapshot, critical) => this.coordinator.merge(snapshot, critical),
      onFlush: async (snapshot, reason) => { await this.coordinator.merge(snapshot, true); await this.coordinator.flush(runId, reason); },
    });
    this.accumulator.context('run_started');
    this.accumulator.checkpoint(true);
    void this.coordinator.deliverPending();
    return runId;
  }

  configureRun(runId: string, runConfig: RecordingRunConfig, recorderSettings: RecorderRuntimeSettingsSnapshot, epoch?: number): void {
    if (this.enabled) this.coordinator.updateRun(runId, recordingContextFromRunConfig(runConfig, recorderSettings), epoch);
  }

  sink(): TelemetrySink | undefined { return this.enabled ? this.accumulator ?? undefined : undefined; }
  isEnabled(): boolean { return this.enabled; }
  currentRunId(): string | null { return this.runId; }
  incident(input: TelemetryIncidentInput): void { this.accumulator?.incident(input); this.accumulator?.checkpoint(true); this.accumulator?.flush('incident'); }
  context(code: string, tags?: Record<string, unknown>): void { this.accumulator?.context(code, tags); }
  checkpoint(): void { this.accumulator?.checkpoint(); }
  completeRecording(runId: string): void {
    if (this.accumulator?.runId !== runId) return;
    const duration = Math.max(0, Date.now() - this.accumulator.snapshot().startedAt);
    this.accumulator.increment('recording.duration.count');
    this.accumulator.increment('recording.duration.total_ms', duration);
    this.accumulator.measure('recording.duration.max_ms', duration);
  }
  flush(reason: 'recording_complete' | 'upload_complete'): void { this.accumulator?.flush(reason); }
  async flushRun(runId: string, reason: 'recording_complete' | 'upload_complete'): Promise<void> {
    if (!this.enabled) return;
    if (this.accumulator?.runId === runId) await this.coordinator.merge(this.accumulator.snapshot(), true);
    await this.coordinator.flush(runId, reason);
  }
  async flushIncidentRun(runId: string): Promise<void> { if (this.enabled) await this.coordinator.flush(runId, 'incident'); }
  bindUploadJob(runId: string, jobId: string): void { if (this.enabled) this.coordinator.bindUploadJob(runId, jobId); }
  runIdForUploadJob(jobId: string): string | null { return this.coordinator.runIdForUploadJob(jobId); }
  async recordRecoveredUploadOutcome(runId: string, job: UploadJob): Promise<void> {
    const duration = Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt);
    const summary: Record<string, number> = {
      [`upload.${job.status}`]: 1,
      'upload.jobs': 1,
      'upload.files': job.files.length,
      'upload.bytes': job.files.reduce((total, file) => total + (file.bytes ?? 0), 0),
      'upload.job.count': 1,
      'upload.job.total_ms': duration,
      'upload.job.max_ms': duration,
    };
    const incidents = job.status === 'partial' || job.status === 'failed' ? [{
      incidentId: createTelemetryId(), kind: job.status === 'partial' ? 'upload_partial' as const : 'upload_failed' as const,
      stage: 'drive_upload', severity: 'error' as const, at: job.finishedAt ?? Date.now(), context: [],
    }] : [];
    await this.coordinator.merge({ runId, source: 'offscreen', startedAt: job.startedAt, endedAt: job.finishedAt ?? Date.now(), summary, incidents }, true);
    await this.coordinator.flush(runId, 'upload_complete');
  }
  async receive(snapshot: TelemetrySnapshot, critical = false): Promise<void> { await this.coordinator.merge(snapshot, critical); }
  async receiveFlush(snapshot: TelemetrySnapshot, reason: 'incident' | 'recording_complete' | 'upload_complete'): Promise<void> {
    await this.coordinator.merge(snapshot, true); await this.coordinator.flush(snapshot.runId, reason);
  }
}
