import type { AnalysisJobStatus } from '../../../shared/analysis/job';

/** Durable control-plane fact describing the latest analysis attempt for one recording. */
export type RecordingAnalysisOutcome = {
  status: AnalysisJobStatus;
  jobId?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

const STATUSES = new Set<AnalysisJobStatus>([
  'analyzing',
  'completed',
  'failed',
  'canceled',
  'unsupported',
]);

export function normalizeRecordingAnalysisOutcome(value: unknown): RecordingAnalysisOutcome | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!STATUSES.has(raw.status as AnalysisJobStatus)) return undefined;
  if (!finiteTimestamp(raw.startedAt) || !finiteTimestamp(raw.updatedAt)) return undefined;

  const jobId = cleanString(raw.jobId, 512);
  const error = cleanString(raw.error, 2_048);
  return {
    status: raw.status as AnalysisJobStatus,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
  };
}

export function isOutcomeAtLeastAsRecent(
  incoming: RecordingAnalysisOutcome,
  current: RecordingAnalysisOutcome,
): boolean {
  if (incoming.startedAt !== current.startedAt) return incoming.startedAt > current.startedAt;
  return incoming.updatedAt >= current.updatedAt;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}
