import type { AnalysisJobStatus } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import {
  normalizeRequiredAnalysisEnvironment,
  requiredAnalysisEnvironment,
  type RecordingAnalysisWork,
  type RequiredAnalysisEnvironment,
} from './RecordingAnalysisWork';

export type RecordingAnalysisOutcomeBinding = {
  requestEpoch: number;
  transcriptGeneration: string;
  transcriptRevision: number;
  transcriptHash: string;
  environment: RequiredAnalysisEnvironment;
};

/** Durable control-plane fact describing the latest analysis attempt for one recording. */
export type RecordingAnalysisOutcome = {
  status: AnalysisJobStatus;
  jobId?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
} & Partial<RecordingAnalysisOutcomeBinding>;

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
  const binding = normalizeBinding(raw);
  return {
    status: raw.status as AnalysisJobStatus,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
    ...binding,
  };
}

export function hasCompleteOutcomeBinding(
  outcome: RecordingAnalysisOutcome,
): outcome is RecordingAnalysisOutcome & RecordingAnalysisOutcomeBinding {
  return outcome.requestEpoch != null
    && outcome.transcriptGeneration != null
    && outcome.transcriptRevision != null
    && outcome.transcriptHash != null
    && outcome.environment != null;
}

export function bindOutcomeToWork(
  outcome: RecordingAnalysisOutcome,
  work: RecordingAnalysisWork,
): RecordingAnalysisOutcome {
  if (!work.transcriptHash) return outcome;
  return {
    ...outcome,
    requestEpoch: work.requestEpoch,
    transcriptGeneration: work.transcriptGeneration,
    transcriptRevision: work.transcriptRevision,
    transcriptHash: work.transcriptHash,
    environment: work.environment,
  };
}

export function bindOutcomeToProvenance(
  outcome: RecordingAnalysisOutcome,
  provenance: AnalysisProvenance,
  requestEpoch = 0,
): RecordingAnalysisOutcome {
  if (requestEpoch <= 0) return outcome;
  return {
    ...outcome,
    requestEpoch,
    transcriptGeneration: provenance.transcriptGeneration,
    transcriptRevision: provenance.transcriptRevision,
    transcriptHash: provenance.transcriptHash,
    environment: requiredAnalysisEnvironment(provenance),
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

function normalizeBinding(raw: Record<string, unknown>): Partial<RecordingAnalysisOutcomeBinding> {
  const requestEpoch = positiveInteger(raw.requestEpoch);
  const transcriptGeneration = cleanString(raw.transcriptGeneration, 512);
  const transcriptRevision = positiveInteger(raw.transcriptRevision);
  const transcriptHash = cleanString(raw.transcriptHash, 256);
  const environment = normalizeRequiredAnalysisEnvironment(raw.environment);
  const present = [
    raw.requestEpoch,
    raw.transcriptGeneration,
    raw.transcriptRevision,
    raw.transcriptHash,
    raw.environment,
  ].some((value) => value !== undefined);
  if (!present) return {};
  if (requestEpoch == null || !transcriptGeneration || transcriptRevision == null || !transcriptHash || !environment) {
    return {};
  }
  return { requestEpoch, transcriptGeneration, transcriptRevision, transcriptHash, environment };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
