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

/** The slice of {@link RecordingFinalizer} the upload manager drives, per job. */
export interface JobFinalizer {
  finalize(opts: {
    artifacts: CompletedRecordingArtifact[];
    storageMode: 'drive';
    onUploadProgress?: (fraction: number) => void;
    skipLocalFallback?: boolean;
  }): Promise<UploadSummary | undefined>;
}

export type UploadManagerDeps = {
  finalizer: JobFinalizer;
  /** Sink for the job's latest state; the offscreen posts it as OFFSCREEN_UPLOAD_STATE. */
  report: (job: UploadJob) => void;
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
  private readonly pending: Array<{ job: UploadJob; artifacts: CompletedRecordingArtifact[]; skipLocalFallback: boolean }> = [];
  private active = 0;
  private seq = 0;
  /**
   * The most-recent job that ended with fallbacks, kept so the popup's "Retry"
   * can re-upload its still-failed files from the retained (default Worker target ⇒
   * in-memory) artifacts. Bounded to one: a newer failure or a successful retry
   * evicts it, so a failed recording can't pin its bytes in memory indefinitely.
   */
  private lastFailed: { jobId: string; artifacts: CompletedRecordingArtifact[] } | null = null;

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
  enqueue(artifacts: CompletedRecordingArtifact[]): string {
    return this.enqueueJob(this.genId(), artifacts);
  }

  /**
   * Re-uploads a failed/partial job's still-failed files from the retained artifacts,
   * under the same job id so its existing tab flips back to `uploading`. Returns false
   * when the job is no longer retryable here (a newer failure evicted it, or the
   * offscreen restarted and lost the bytes).
   */
  retry(jobId: string): boolean {
    if (this.lastFailed?.jobId !== jobId) return false;
    const { artifacts } = this.lastFailed;
    this.lastFailed = null;
    // The original failure already saved a local copy, so suppress the download
    // failsafe on the retry — a re-failure must not duplicate it (ADR-0004).
    this.enqueueJob(jobId, artifacts, true);
    return true;
  }

  private enqueueJob(id: string, artifacts: CompletedRecordingArtifact[], skipLocalFallback = false): string {
    const job: UploadJob = {
      id,
      label: inferDriveRecordingFolderName(artifacts[0]?.artifact.filename ?? id),
      status: 'uploading',
      progress: 0,
      files: artifacts.map(({ stream, artifact }) => ({ stream, filename: artifact.filename, status: 'uploading' })),
      startedAt: this.now(),
    };
    this.pending.push({ job, artifacts, skipLocalFallback });
    this.deps.report(job);
    this.pump();
    return id;
  }

  /** True while any job is queued or uploading; feeds the ADR-0004 "busy" check. */
  hasActiveJobs(): boolean {
    return this.active > 0 || this.pending.length > 0;
  }

  /** Starts queued jobs up to the concurrency limit, refilling as each settles. */
  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.active += 1;
      void this.run(next.job, next.artifacts, next.skipLocalFallback).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: UploadJob, artifacts: CompletedRecordingArtifact[], skipLocalFallback = false): Promise<void> {
    let lastProgress = job.progress;
    try {
      const summary = await this.deps.finalizer.finalize({
        artifacts,
        storageMode: 'drive',
        skipLocalFallback,
        onUploadProgress: (fraction) => {
          lastProgress = fraction;
          this.deps.report({ ...job, status: 'uploading', progress: fraction });
        },
      });
      const settled = this.settle(job, summary);
      this.rememberRetryable(settled, artifacts);
      this.deps.report(settled);
    } catch (e) {
      // A thrown error (vs. a per-file fallback) means the whole job could not be
      // persisted; surface it as failed with the last progress we observed.
      this.deps.warn?.('Upload job failed', job.label, describeRuntimeError(e));
      const failed: UploadJob = {
        ...job,
        status: 'failed',
        progress: lastProgress,
        files: job.files.map((f) => ({ ...f, status: 'fallback' })),
        finishedAt: this.now(),
      };
      this.rememberRetryable(failed, artifacts);
      this.deps.report(failed);
    }
  }

  /** Retains the still-failed artifacts of a fallen-back job for "Retry"; clears the
   *  retained entry once a job (re-)settles cleanly. */
  private rememberRetryable(settled: UploadJob, artifacts: CompletedRecordingArtifact[]): void {
    const failedFiles = new Set(settled.files.filter((f) => f.status === 'fallback').map((f) => f.filename));
    if (failedFiles.size > 0) {
      this.lastFailed = { jobId: settled.id, artifacts: artifacts.filter((a) => failedFiles.has(a.artifact.filename)) };
    } else if (this.lastFailed?.jobId === settled.id) {
      this.lastFailed = null;
    }
  }

  /**
   * Derives the terminal job state from the finalizer's per-file summary: every
   * file uploaded ⇒ `completed`, some fell back to a local download ⇒ `partial`,
   * all fell back ⇒ `failed`. Progress is pinned to 1 — the finalizer drives every
   * file to done (uploaded or saved locally) before returning.
   */
  private settle(job: UploadJob, summary: UploadSummary | undefined): UploadJob {
    const uploaded = new Set((summary?.uploaded ?? []).map((e) => e.filename));
    const fellBack = new Set((summary?.localFallbacks ?? []).map((e) => e.filename));
    const files: UploadJobFile[] = job.files.map((f) => ({
      ...f,
      status: uploaded.has(f.filename) ? 'uploaded' : fellBack.has(f.filename) ? 'fallback' : f.status,
    }));
    const allFallback = files.length > 0 && files.every((f) => f.status === 'fallback');
    const anyFallback = files.some((f) => f.status === 'fallback');
    const status: UploadJobStatus = allFallback ? 'failed' : anyFallback ? 'partial' : 'completed';
    return { ...job, status, progress: 1, files, finishedAt: this.now() };
  }
}
