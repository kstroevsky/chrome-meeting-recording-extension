/**
 * @file offscreen/UploadManager.ts
 *
 * Background Drive-upload job runner (ADR-0004). When a recording stops, its
 * sealed artifacts are enqueued here as one **upload job** and uploaded
 * independently of the recording session — so a new recording can start while a
 * previous upload is still in flight.
 *
 * Each job reuses {@link RecordingFinalizer}'s Drive logic (folder resolve,
 * bounded per-file concurrency, local fallback, pending-marker recovery) via the
 * injected {@link JobFinalizer} seam, reports its progress/terminal status through
 * `report` (the offscreen posts these as OFFSCREEN_UPLOAD_STATE), and runs under a
 * bounded job-concurrency so an upload never starves a concurrent live capture.
 */

import type { CompletedRecordingArtifact } from './engine/RecorderEngineTypes';
import type { UploadJob, UploadJobFile, UploadJobStatus, UploadSummary } from '../shared/recording';
import { inferDriveRecordingFolderName } from './drive/folderNaming';
import { describeRuntimeError } from './errors';

const MAX_RETRYABLE_BYTES = 128 * 1024 * 1024;
const RETRY_RETENTION_MS = 5 * 60 * 1000;

/** The slice of {@link RecordingFinalizer} the upload manager drives, per job. */
export interface JobFinalizer {
  finalize(opts: {
    artifacts: CompletedRecordingArtifact[];
    storageMode: 'drive';
    onUploadProgress?: (fraction: number) => void;
    skipLocalFallback?: boolean;
    signal?: AbortSignal;
    historyId?: string;
    uploadJobId?: string;
  }): Promise<UploadSummary | undefined>;
}

export type UploadManagerDeps = {
  finalizer: JobFinalizer;
  /** Sink for the job's latest state; the offscreen posts it as OFFSCREEN_UPLOAD_STATE. */
  report: (job: UploadJob, telemetryRunId?: string) => void | Promise<void>;
  /** Max jobs uploading at once; default 1 so an upload never starves a live capture. */
  concurrency?: number;
  now?: () => number;
  genId?: () => string;
  warn?: (...a: any[]) => void;
};

export class UploadManager {
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly pending: UploadTask[] = [];
  private readonly jobs = new Map<string, UploadTask>();
  private active = 0;
  private seq = 0;
  /**
   * The most-recent job that ended with fallbacks, kept so the popup's "Retry"
   * can re-upload its still-failed files from the retained (default Worker target ⇒
   * in-memory) artifacts. Bounded to one: a newer failure or a successful retry
   * evicts it, so a failed recording can't pin its bytes in memory indefinitely.
   */
  private lastFailed: { jobId: string; historyId?: string; telemetryRunId?: string; artifacts: CompletedRecordingArtifact[]; expiresAt: number } | null = null;
  private retryExpiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: UploadManagerDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? 1);
    this.now = deps.now ?? Date.now;
    this.genId = deps.genId ?? (() => `upl_${this.now()}_${(this.seq += 1)}`);
  }

  /**
   * Enqueues a finished recording's sealed artifacts as a background Drive-upload
   * job and returns its id. Reports the job's initial `uploading` state immediately
   * so a tab appears at once, then pumps the queue.
   */
  enqueue(artifacts: CompletedRecordingArtifact[], historyId?: string, telemetryRunId?: string): string {
    return this.enqueueJob(this.genId(), artifacts, false, historyId, telemetryRunId);
  }

  /**
   * Re-uploads a failed/partial job's still-failed files from the retained artifacts,
   * under the same job id so its existing tab flips back to `uploading`. Returns false
   * when the job is no longer retryable here (a newer failure evicted it, or the
   * offscreen restarted and lost the bytes).
   */
  retry(jobId: string): boolean {
    this.clearExpiredRetry();
    if (this.lastFailed?.jobId !== jobId) return false;
    const { artifacts, historyId, telemetryRunId } = this.lastFailed;
    this.clearRetryable();
    // The original failure already saved a local copy, so suppress the download
    // failsafe on the retry — a re-failure must not duplicate it (ADR-0004).
    this.enqueueJob(jobId, artifacts, true, historyId, telemetryRunId);
    return true;
  }

  /** Aborts a queued/active upload. Its unfinished artifacts are downloaded locally. */
  cancel(jobId: string): boolean {
    const task = this.jobs.get(jobId);
    if (!task || task.controller.signal.aborted) return false;
    task.controller.abort();
    return true;
  }

  private enqueueJob(id: string, artifacts: CompletedRecordingArtifact[], skipLocalFallback = false, historyId?: string, telemetryRunId?: string): string {
    const job: UploadJob = {
      id,
      historyId,
      label: inferDriveRecordingFolderName(artifacts[0]?.artifact.filename ?? id),
      status: 'uploading',
      progress: 0,
      files: artifacts.map(({ stream, kind, artifact }) => ({
        stream,
        ...(kind ? { kind } : {}),
        filename: artifact.filename,
        status: 'uploading',
        bytes: artifact.file.size,
        ...(artifact.startOffsetMs != null ? { startOffsetMs: artifact.startOffsetMs } : {}),
      })),
      startedAt: this.now(),
    };
    job.driveFolderName = job.label;
    const task = { job, artifacts, skipLocalFallback, telemetryRunId, controller: new AbortController() };
    this.pending.push(task);
    this.jobs.set(id, task);
    void this.emit(job);
    this.pump();
    return id;
  }

  /** True while any job is queued or uploading; feeds the ADR-0004 "busy" check. */
  hasActiveJobs(): boolean {
    return this.jobs.size > 0;
  }

  /** Replays current in-flight work after a background reconnect. */
  activeJobs(): UploadJob[] {
    return [...this.jobs.values()].map((task) => structuredClone(task.job));
  }

  telemetryRunId(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.telemetryRunId;
  }

  /** Starts queued jobs up to the concurrency limit, refilling as each settles. */
  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.active += 1;
      void this.run(next).finally(() => {
        this.active -= 1;
        this.jobs.delete(next.job.id);
        this.pump();
      });
    }
  }

  private async run(task: UploadTask): Promise<void> {
    const { job, artifacts, skipLocalFallback, controller } = task;
    let lastProgress = job.progress;
    try {
      const summary = await this.deps.finalizer.finalize({
        artifacts,
        storageMode: 'drive',
        skipLocalFallback,
        signal: controller.signal,
        historyId: job.historyId,
        uploadJobId: job.id,
        onUploadProgress: (fraction) => {
          lastProgress = fraction;
          const progress = { ...task.job, status: 'uploading' as const, progress: fraction };
          task.job = progress;
          void this.emit(progress);
        },
      });
      const settled = this.settle(job, summary, controller.signal.aborted);
      if (!controller.signal.aborted) this.rememberRetryable(settled, artifacts);
      await this.emit(settled);
    } catch (e) {
      // A thrown error (vs. a per-file fallback) means the whole job could not be
      // persisted; surface it as failed with the last progress we observed.
      this.deps.warn?.('Upload job failed', job.label, describeRuntimeError(e));
      const failed: UploadJob = {
        ...job,
        status: controller.signal.aborted ? 'canceled' : 'failed',
        progress: lastProgress,
        files: job.files.map((f) => ({ ...f, status: 'fallback' })),
        finishedAt: this.now(),
      };
      if (!controller.signal.aborted) this.rememberRetryable(failed, artifacts);
      await this.emit(failed);
    }
  }

  /** Retains the still-failed artifacts of a fallen-back job for "Retry"; clears the
   *  retained entry once a job (re-)settles cleanly. */
  private rememberRetryable(settled: UploadJob, artifacts: CompletedRecordingArtifact[]): void {
    const failedFiles = new Set(settled.files.filter((f) => f.status === 'fallback').map((f) => f.filename));
    if (failedFiles.size > 0) {
      const retryArtifacts = artifacts.filter((artifact) => failedFiles.has(artifact.artifact.filename));
      const bytes = retryArtifacts.reduce((total, entry) => total + entry.artifact.file.size, 0);
      if (bytes > MAX_RETRYABLE_BYTES) {
        this.clearRetryable();
        this.deps.warn?.(`Upload retry unavailable for ${settled.label}: ${bytes} bytes exceeds the ${MAX_RETRYABLE_BYTES}-byte retention budget`);
        return;
      }
      this.clearRetryable();
      this.lastFailed = {
        jobId: settled.id,
        historyId: settled.historyId,
        telemetryRunId: this.jobs.get(settled.id)?.telemetryRunId,
        artifacts: retryArtifacts,
        expiresAt: this.now() + RETRY_RETENTION_MS,
      };
      this.retryExpiryTimer = setTimeout(() => this.clearExpiredRetry(), RETRY_RETENTION_MS);
    } else if (this.lastFailed?.jobId === settled.id) {
      this.clearRetryable();
    }
  }

  private async emit(job: UploadJob): Promise<void> {
    try {
      await this.deps.report(job, this.jobs.get(job.id)?.telemetryRunId);
    } catch (error) {
      // Transport failure must never change the completed upload outcome. The
      // offscreen outbox retries terminal delivery after reconnect.
      this.deps.warn?.('Could not report upload state', job.id, describeRuntimeError(error));
    }
  }

  private clearExpiredRetry(): void {
    if (this.lastFailed && this.lastFailed.expiresAt <= this.now()) this.clearRetryable();
  }

  private clearRetryable(): void {
    if (this.retryExpiryTimer != null) clearTimeout(this.retryExpiryTimer);
    this.retryExpiryTimer = null;
    this.lastFailed = null;
  }

  /**
   * Derives the terminal job state from the finalizer's per-file summary: every
   * file uploaded ⇒ `completed`, some fell back to a local download ⇒ `partial`,
   * all fell back ⇒ `failed`. Progress is pinned to 1 — the finalizer drives every
   * file to done (uploaded or saved locally) before returning.
   */
  private settle(job: UploadJob, summary: UploadSummary | undefined, canceled = false): UploadJob {
    const uploaded = new Map((summary?.uploaded ?? []).map((e) => [e.filename, e]));
    const fellBack = new Map((summary?.localFallbacks ?? []).map((e) => [e.filename, e]));
    const files: UploadJobFile[] = job.files.map((f) => {
      const uploadedFile = uploaded.get(f.filename);
      const fallbackFile = fellBack.get(f.filename);
      return {
        ...f,
        bytes: uploadedFile?.bytes ?? fallbackFile?.bytes ?? f.bytes,
        driveFileId: uploadedFile?.driveFileId ?? f.driveFileId,
        webViewLink: uploadedFile?.webViewLink ?? f.webViewLink,
        status: uploadedFile ? 'uploaded' : fallbackFile ? 'fallback' : f.status,
      };
    });
    const allFallback = files.length > 0 && files.every((f) => f.status === 'fallback');
    const anyFallback = files.some((f) => f.status === 'fallback');
    const status: UploadJobStatus = canceled ? 'canceled' : allFallback ? 'failed' : anyFallback ? 'partial' : 'completed';
    return {
      ...job,
      status,
      progress: 1,
      folderWebViewLink: summary?.folderWebViewLink ?? job.folderWebViewLink,
      driveFolderId: summary?.driveFolderId ?? job.driveFolderId,
      driveFolderName: summary?.driveFolderName ?? job.driveFolderName,
      namingStatus: status === 'completed' && job.historyId ? (job.namingStatus ?? 'pending') : undefined,
      files,
      finishedAt: this.now(),
    };
  }
}

type UploadTask = {
  job: UploadJob;
  artifacts: CompletedRecordingArtifact[];
  skipLocalFallback: boolean;
  telemetryRunId?: string;
  controller: AbortController;
};
