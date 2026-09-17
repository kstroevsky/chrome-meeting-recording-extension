/**
 * @file shared/analysis/job.ts
 *
 * One run of the deterministic pipeline over one recording, as a durable fact.
 *
 * An analysis job is the same *shape* of problem ADR-0004 solved for uploads —
 * long work in the data plane whose owner in the control plane can be
 * terminated at any moment — so the contract deliberately mirrors `UploadJob`:
 * a status that reaches a terminal value, a progress fraction, and a job id the
 * background acknowledges by.
 *
 * It differs in what it carries. An upload job describes files; this describes
 * *windows encoded out of how many*, because that is the only part of analysis
 * with a knowable denominator — the windows are built before the first batch is
 * encoded, so progress here is a real fraction rather than an estimate.
 *
 * **The result is not in the job.** A completed job says a recording was
 * analysed and how it went; the analysis itself goes to the `analyses` store
 * through `RecordingAnalysisService`. Keeping megabytes of vectors out of
 * `chrome.storage.local` is the practical reason; the structural one is that
 * the outbox exists to survive a service-worker death, and duplicating the
 * payload there would make two writers of the same truth.
 */

/** Terminal-or-running state of one analysis job (HOST-03). */
export type AnalysisJobStatus = 'analyzing' | 'completed' | 'failed' | 'canceled' | 'unsupported';

export type AnalysisJob = {
  id: string;
  /** The recording this analyses; the key its result is stored under. */
  historyId: string;
  status: AnalysisJobStatus;
  /** Fraction of windows encoded, in [0, 1]. */
  progress: number;
  /** Known once the windows are built, which happens before the first batch. */
  windowsTotal?: number;
  windowsEncoded?: number;
  /** Set on `completed`: what the run produced, for a surface that wants a count. */
  topicCount?: number;
  segmentCount?: number;
  /** Which rung of the ladder ran, so a slow run is explicable (RES-06). */
  device?: 'webgpu' | 'wasm';
  /** Set on `failed` and `unsupported`: why, in words a user could read. */
  error?: string;
  /**
   * Set on a `failed` job whose analysis *had* completed, but whose result was
   * lost because the offscreen document holding it restarted before background
   * acknowledged it. The outbox row survived; the payload could not. Safe to
   * re-run — nothing about the recording is wrong.
   */
  lostResult?: true;
  startedAt: number;
  /** Set once the job reaches a terminal status. */
  finishedAt?: number;
};

const TERMINAL_STATUSES: readonly AnalysisJobStatus[] = ['completed', 'failed', 'canceled', 'unsupported'];

/** Whether a job has stopped moving — the condition for entering the outbox. */
export function isTerminalAnalysisJob(job: AnalysisJob): boolean {
  return TERMINAL_STATUSES.includes(job.status);
}

/**
 * Rebuilds a job from untrusted storage, or `undefined` when it is not one.
 *
 * Strict about the fields that make the job *addressable* (`id`, `historyId`,
 * `status`, `startedAt`) and forgiving about the rest, because a damaged
 * progress number should not cost the background the knowledge that a run
 * finished — while a job with no id could never be acknowledged and is better
 * discarded than kept.
 */
export function normalizeAnalysisJob(value: unknown): AnalysisJob | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : undefined;
  const historyId = typeof raw.historyId === 'string' && raw.historyId.trim() ? raw.historyId : undefined;
  const status = isAnalysisJobStatus(raw.status) ? raw.status : undefined;
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : undefined;
  if (!id || !historyId || !status || startedAt == null) return undefined;

  const job: AnalysisJob = {
    id,
    historyId,
    status,
    progress: clampFraction(raw.progress),
    startedAt,
  };
  const windowsTotal = nonNegativeInt(raw.windowsTotal);
  if (windowsTotal != null) job.windowsTotal = windowsTotal;
  const windowsEncoded = nonNegativeInt(raw.windowsEncoded);
  if (windowsEncoded != null) job.windowsEncoded = windowsEncoded;
  const topicCount = nonNegativeInt(raw.topicCount);
  if (topicCount != null) job.topicCount = topicCount;
  const segmentCount = nonNegativeInt(raw.segmentCount);
  if (segmentCount != null) job.segmentCount = segmentCount;
  if (raw.device === 'webgpu' || raw.device === 'wasm') job.device = raw.device;
  if (typeof raw.error === 'string' && raw.error.trim()) job.error = raw.error;
  if (raw.lostResult === true) job.lostResult = true;
  const finishedAt = typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt) ? raw.finishedAt : undefined;
  if (finishedAt != null) job.finishedAt = finishedAt;
  return job;
}

function isAnalysisJobStatus(value: unknown): value is AnalysisJobStatus {
  return value === 'analyzing' || TERMINAL_STATUSES.includes(value as AnalysisJobStatus);
}

function clampFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}
