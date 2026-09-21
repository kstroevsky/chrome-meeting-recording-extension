import { setActionBadgeText } from '../../platform/chrome/action';
import {
  isOffscreenToBgMessage,
  type OffscreenToBg,
} from '../../shared/protocol';
import {
  normalizePhase,
  type RecordingPhase,
  type UploadJob,
} from '../../shared/recording';
import type { AnalysisJob } from '../../shared/analysis/job';
import type { WireAnalysis } from '../../shared/analysis/storedAnalysis';
import type { AnalysisProvenance } from '../../shared/analysis/provenance';
import type { OffscreenHost } from './OffscreenHost';

export type OffscreenStateListener = (
  msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_STATE' }>,
) => void;
export type OffscreenSaveListener = (
  msg: Extract<OffscreenToBg, { type: 'OFFSCREEN_SAVE' }>,
) => void;
export type OffscreenUploadListener = (
  job: UploadJob,
  telemetryRunId?: string,
  telemetrySnapshot?: import('../../shared/telemetry').TelemetrySnapshot,
) => void;
export type OffscreenAnalysisListener = (job: AnalysisJob) => void;
export type OffscreenAnalysisResultListener = (
  job: AnalysisJob,
  analysis: WireAnalysis,
  provenance?: AnalysisProvenance,
) => void;

export class OffscreenEventRouter {
  private lastKnownPhase: RecordingPhase = 'idle';
  private readonly activeUploadJobs = new Set<string>();
  private readonly activeAnalysisJobs = new Set<string>();

  onStateChanged?: OffscreenStateListener;
  onSaveRequested?: OffscreenSaveListener;
  onUploadJobChanged?: OffscreenUploadListener;
  onAnalysisJobChanged?: OffscreenAnalysisListener;
  onAnalysisResult?: OffscreenAnalysisResultListener;

  constructor(private readonly host: OffscreenHost) {
    this.setBadge('idle');
  }

  handleDisconnected(): void {
    void setActionBadgeText('');
  }

  route(msg: unknown): void {
    if (!isOffscreenToBgMessage(msg)) return;

    if (msg.type === 'OFFSCREEN_READY') {
      this.host.handleReady(msg.version);
      return;
    }

    if (msg.type === 'OFFSCREEN_STATE') {
      const phase = normalizePhase(msg.phase);
      this.lastKnownPhase = phase;
      this.setBadge(phase);
      if (phase === 'idle') {
        this.host.scheduleRecorderTabCleanup(() => this.canCloseRecorderTab());
      } else {
        this.host.cancelRecorderTabCleanup();
      }
      this.onStateChanged?.({ ...msg, phase });
      return;
    }

    if (msg.type === 'OFFSCREEN_UPLOAD_STATE') {
      if (msg.job.status === 'uploading') this.activeUploadJobs.add(msg.job.id);
      else this.activeUploadJobs.delete(msg.job.id);
      if (this.activeUploadJobs.size > 0) this.host.cancelRecorderTabCleanup();
      this.setBadge(this.lastKnownPhase);
      if (msg.telemetryRunId || msg.telemetrySnapshot) {
        this.onUploadJobChanged?.(
          msg.job,
          msg.telemetryRunId,
          msg.telemetrySnapshot,
        );
      } else {
        this.onUploadJobChanged?.(msg.job);
      }
      return;
    }

    if (msg.type === 'OFFSCREEN_ANALYSIS_STATE') {
      if (holdsAnalysisWork(msg.job)) this.activeAnalysisJobs.add(msg.job.id);
      else this.activeAnalysisJobs.delete(msg.job.id);
      if (this.activeAnalysisJobs.size > 0) this.host.cancelRecorderTabCleanup();
      this.onAnalysisJobChanged?.(msg.job);
      return;
    }

    if (msg.type === 'OFFSCREEN_ANALYSIS_RESULT') {
      this.onAnalysisResult?.(msg.job, msg.analysis, msg.provenance);
      return;
    }

    if (msg.type === 'OFFSCREEN_SAVE') this.onSaveRequested?.(msg);
  }

  hydratePhase(phase: RecordingPhase): void {
    this.lastKnownPhase = phase;
    this.setBadge(phase);
  }

  hydrateUploadJobs(jobs: UploadJob[] | undefined): void {
    this.activeUploadJobs.clear();
    for (const job of jobs ?? []) {
      if (job.status === 'uploading') this.activeUploadJobs.add(job.id);
    }
    this.setBadge(this.lastKnownPhase);
  }

  hydrateAnalysisJobs(jobs: AnalysisJob[] | undefined): void {
    this.activeAnalysisJobs.clear();
    for (const job of jobs ?? []) {
      if (holdsAnalysisWork(job)) this.activeAnalysisJobs.add(job.id);
    }
  }

  replaceAnalysisJobs(jobIds: string[]): void {
    this.activeAnalysisJobs.clear();
    for (const jobId of jobIds) this.activeAnalysisJobs.add(jobId);
  }

  acknowledgeAnalysis(jobId: string): void {
    this.activeAnalysisJobs.delete(jobId);
  }

  get phase(): RecordingPhase {
    return this.lastKnownPhase;
  }

  get hasActiveAnalysisJobs(): boolean {
    return this.activeAnalysisJobs.size > 0;
  }

  get hasBackgroundWork(): boolean {
    return this.activeUploadJobs.size > 0 || this.activeAnalysisJobs.size > 0;
  }

  showIdleBadge(): void {
    this.setBadge('idle');
  }

  private canCloseRecorderTab(): boolean {
    return this.lastKnownPhase === 'idle'
      && this.activeUploadJobs.size === 0
      && this.activeAnalysisJobs.size === 0;
  }

  private setBadge(phase: RecordingPhase): void {
    const text = phase === 'failed'
      ? 'ERR'
      : phase === 'idle'
        ? this.activeUploadJobs.size > 0 ? 'UP' : ''
        : 'REC';
    void setActionBadgeText(text);
  }
}

function holdsAnalysisWork(job: AnalysisJob): boolean {
  return job.status === 'analyzing'
    || job.status === 'completed'
    || (job.status === 'failed' && job.lostResult === true);
}
