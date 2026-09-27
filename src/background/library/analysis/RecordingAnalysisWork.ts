import type {
  AnalysisEnvironmentProvenance,
  EmbeddingDtype,
} from '../../../shared/analysis/provenance';
import type { TranscriptIdentity } from '../../../shared/transcriptIdentity';

export type RequiredAnalysisEnvironment = Omit<AnalysisEnvironmentProvenance, 'embeddingDevice'>;

export type AnalysisWorkDisposition =
  | 'hash-pending'
  | 'pending'
  | 'claimed'
  | 'retry-wait'
  | 'canceled'
  | 'unsupported'
  | 'satisfied';

export type AnalysisWorkClaim = {
  attemptToken: string;
  claimedAt: number;
  leaseUntil: number;
};

/**
 * The durable desired state for analysis of one recording.
 *
 * There is one row per recording and requestEpoch never moves backwards. A
 * worker attempt is only allowed to retire or publish this row when the epoch,
 * transcript identity, environment and attempt token still match.
 */
export type RecordingAnalysisWork = {
  recordingId: string;
  transcriptGeneration: string;
  transcriptRevision: number;
  transcriptHash?: string;
  environment: RequiredAnalysisEnvironment;
  requestEpoch: number;
  disposition: AnalysisWorkDisposition;
  attemptCount: number;
  /** Present only while this row should become dispatchable at a known time. */
  nextAttemptAt?: number;
  claim?: AnalysisWorkClaim;
  error?: string;
  updatedAt: number;
};

const DTYPES = new Set<EmbeddingDtype>([
  'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4',
]);

export function requiredAnalysisEnvironment(
  value: AnalysisEnvironmentProvenance,
): RequiredAnalysisEnvironment {
  return {
    pipelineVersion: value.pipelineVersion,
    embeddingModel: value.embeddingModel,
    embeddingModelRevision: value.embeddingModelRevision,
    embeddingDimensions: value.embeddingDimensions,
    embeddingDtype: value.embeddingDtype,
    configHash: value.configHash,
  };
}

export function sameRequiredAnalysisEnvironment(
  left: RequiredAnalysisEnvironment,
  right: RequiredAnalysisEnvironment,
): boolean {
  return left.pipelineVersion === right.pipelineVersion
    && left.embeddingModel === right.embeddingModel
    && left.embeddingModelRevision === right.embeddingModelRevision
    && left.embeddingDimensions === right.embeddingDimensions
    && left.embeddingDtype === right.embeddingDtype
    && left.configHash === right.configHash;
}

/** Creates or refreshes the one desired-work row for a transcript commit. */
export function requestAnalysisWork(
  current: RecordingAnalysisWork | undefined,
  recordingId: string,
  transcript: TranscriptIdentity,
  environment: AnalysisEnvironmentProvenance,
  now: number,
  force = false,
): RecordingAnalysisWork {
  const requiredEnvironment = requiredAnalysisEnvironment(environment);
  const sameBaseIdentity = current
    && current.recordingId === recordingId
    && current.transcriptGeneration === transcript.generation
    && current.transcriptRevision === transcript.revision
    && sameRequiredAnalysisEnvironment(current.environment, requiredEnvironment);
  const compatibleHash = sameBaseIdentity
    && (!current.transcriptHash || !transcript.contentHash || current.transcriptHash === transcript.contentHash);

  if (!force && compatibleHash) {
    if (!current.transcriptHash && transcript.contentHash) {
      return {
        ...current,
        transcriptHash: transcript.contentHash,
        ...(current.disposition === 'hash-pending'
          ? { disposition: 'pending' as const, nextAttemptAt: 0 }
          : {}),
        updatedAt: now,
      };
    }
    return current;
  }

  const runnable = Boolean(transcript.contentHash);
  return {
    recordingId,
    transcriptGeneration: transcript.generation,
    transcriptRevision: transcript.revision,
    ...(transcript.contentHash ? { transcriptHash: transcript.contentHash } : {}),
    environment: requiredEnvironment,
    requestEpoch: (current?.requestEpoch ?? 0) + 1,
    disposition: runnable ? 'pending' : 'hash-pending',
    attemptCount: 0,
    ...(runnable ? { nextAttemptAt: 0 } : {}),
    updatedAt: now,
  };
}

export function normalizeRecordingAnalysisWork(value: unknown): RecordingAnalysisWork | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const recordingId = nonEmptyString(raw.recordingId);
  const transcriptGeneration = nonEmptyString(raw.transcriptGeneration);
  const transcriptRevision = positiveInteger(raw.transcriptRevision);
  const requestEpoch = positiveInteger(raw.requestEpoch);
  const attemptCount = nonNegativeInteger(raw.attemptCount);
  const updatedAt = nonNegativeNumber(raw.updatedAt);
  const environment = normalizeEnvironment(raw.environment);
  const disposition = normalizeDisposition(raw.disposition);
  if (!recordingId || !transcriptGeneration || transcriptRevision == null
    || requestEpoch == null || attemptCount == null || updatedAt == null
    || !environment || !disposition) return undefined;

  const transcriptHash = nonEmptyString(raw.transcriptHash);
  const nextAttemptAt = nonNegativeNumber(raw.nextAttemptAt);
  const error = nonEmptyString(raw.error);
  const claim = normalizeClaim(raw.claim);
  return {
    recordingId,
    transcriptGeneration,
    transcriptRevision,
    ...(transcriptHash ? { transcriptHash } : {}),
    environment,
    requestEpoch,
    disposition,
    attemptCount,
    ...(nextAttemptAt != null ? { nextAttemptAt } : {}),
    ...(claim ? { claim } : {}),
    ...(error ? { error } : {}),
    updatedAt,
  };
}

function normalizeEnvironment(value: unknown): RequiredAnalysisEnvironment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const pipelineVersion = nonNegativeInteger(raw.pipelineVersion);
  const embeddingModel = nonEmptyString(raw.embeddingModel);
  const embeddingModelRevision = nonEmptyString(raw.embeddingModelRevision);
  const embeddingDimensions = positiveInteger(raw.embeddingDimensions);
  const embeddingDtype = typeof raw.embeddingDtype === 'string' && DTYPES.has(raw.embeddingDtype as EmbeddingDtype)
    ? raw.embeddingDtype as EmbeddingDtype
    : undefined;
  const configHash = nonEmptyString(raw.configHash);
  if (pipelineVersion == null || !embeddingModel || !embeddingModelRevision
    || embeddingDimensions == null || !embeddingDtype || !configHash) return undefined;
  return {
    pipelineVersion,
    embeddingModel,
    embeddingModelRevision,
    embeddingDimensions,
    embeddingDtype,
    configHash,
  };
}

function normalizeClaim(value: unknown): AnalysisWorkClaim | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const attemptToken = nonEmptyString(raw.attemptToken);
  const claimedAt = nonNegativeNumber(raw.claimedAt);
  const leaseUntil = nonNegativeNumber(raw.leaseUntil);
  return attemptToken && claimedAt != null && leaseUntil != null
    ? { attemptToken, claimedAt, leaseUntil }
    : undefined;
}

function normalizeDisposition(value: unknown): AnalysisWorkDisposition | undefined {
  return value === 'hash-pending'
    || value === 'pending'
    || value === 'claimed'
    || value === 'retry-wait'
    || value === 'canceled'
    || value === 'unsupported'
    || value === 'satisfied'
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
