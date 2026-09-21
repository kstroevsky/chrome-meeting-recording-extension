import type { UploadJob } from '../../shared/recording';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { RecordingSession } from '../recording/session/RecordingSession';

type Logger = {
  warn: (...args: any[]) => void;
};

type TelemetrySnapshot = Parameters<TelemetryRuntime['receive']>[0];

/** Serializes upload state into both durable projections before replay ACKs. */
export class UploadStatePersistence {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: RecordingSession,
    private readonly history: RecordingHistoryService,
    private readonly offscreen: OffscreenManager,
    private readonly telemetry: TelemetryRuntime,
    private readonly logger: Logger,
  ) {}

  handleChanged(
    job: UploadJob,
    telemetryRunId?: string,
    telemetrySnapshot?: TelemetrySnapshot,
  ): void {
    if (telemetryRunId) this.telemetry.bindUploadJob(telemetryRunId, job.id);
    const owningRunId = telemetryRunId ?? this.telemetry.runIdForUploadJob(job.id);
    if (job.status !== 'uploading' && owningRunId) {
      if (telemetrySnapshot) {
        void this.telemetry.receive(telemetrySnapshot, true)
          .then(() => this.telemetry.flushRun(owningRunId, 'upload_complete'))
          .catch(() => {});
      } else {
        void this.telemetry.recordRecoveredUploadOutcome(owningRunId, job).catch(() => {});
      }
    }

    const snapshot = structuredClone(job);
    this.tail = this.tail
      .catch(() => {})
      .then(() => this.persist(snapshot));
    void this.tail.catch(() => {});
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private async persist(job: UploadJob): Promise<void> {
    try {
      if (job.status === 'uploading') {
        this.session.upsertUploadJob(job);
        await this.session.flush();
        await this.history.applyUploadJob(job);
      } else {
        await this.history.applyUploadJob(job);
        this.session.upsertUploadJob(job);
        await this.session.flush();
      }

      if (job.historyId) {
        await this.history.setDuration(job.historyId, this.session.runDurationMs(job.historyId));
      }
      if (job.status !== 'uploading') {
        await this.offscreen.acknowledgeUploadState?.(job.id);
      }
    } catch (error) {
      this.logger.warn('Could not persist upload state:', error);
    }
  }
}
