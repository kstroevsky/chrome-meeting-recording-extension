import { normalizeTranscript, type Transcript } from '../../../shared/transcript';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptIdentity,
  type TranscriptSnapshot,
} from '../../../shared/transcriptIdentity';

export type DurableTranscript = {
  recordingId: string;
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  canonicalizationVersion: typeof TRANSCRIPT_CANONICALIZATION_VERSION;
  generation: string;
  revision: number;
  contentHash?: string;
  committedAt: number;
  transcript: Transcript;
};

export function transcriptIdentityOf(snapshot: TranscriptSnapshot): TranscriptIdentity {
  return {
    generation: snapshot.generation,
    revision: snapshot.revision,
    contentHash: snapshot.contentHash,
  };
}

export function toDurableTranscript(recordingId: string, snapshot: TranscriptSnapshot): DurableTranscript {
  return {
    recordingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: snapshot.generation,
    revision: snapshot.revision,
    ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
    committedAt: snapshot.committedAt,
    transcript: snapshot.transcript,
  };
}

export function readStoredTranscript(value: unknown): TranscriptSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const nested = normalizeTranscript(candidate.transcript);
  if (nested?.segments.length) {
    const revision = finitePositiveInteger(candidate.revision) ?? 1;
    const committedAt = finiteNonNegative(candidate.committedAt) ?? finiteNonNegative(candidate.updatedAt) ?? 0;
    const generation = typeof candidate.generation === 'string' && candidate.generation
      ? candidate.generation
      : legacyGeneration(candidate.recordingId, revision, committedAt);
    const contentHash = candidate.canonicalizationVersion === TRANSCRIPT_CANONICALIZATION_VERSION
      && typeof candidate.contentHash === 'string'
      && isSha256Hex(candidate.contentHash)
      ? candidate.contentHash
      : '';
    return {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
      generation,
      revision,
      contentHash,
      committedAt,
      transcript: nested,
    };
  }

  // Legacy v5-v8 rows flattened the Transcript fields into the store row.
  const legacy = normalizeTranscript(value);
  if (!legacy?.segments.length) return undefined;
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: legacyGeneration(candidate.recordingId, 1, finiteNonNegative(candidate.updatedAt) ?? 0),
    revision: 1,
    contentHash: '',
    committedAt: finiteNonNegative(candidate.updatedAt) ?? 0,
    transcript: legacy,
  };
}

export function createTranscriptGeneration(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function sameTranscript(left: Transcript, right: Transcript): boolean {
  if (left.source !== right.source || left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index];
    return segment.tStartMs === other.tStartMs
      && segment.tEndMs === other.tEndMs
      && segment.speaker === other.speaker
      && segment.text === other.text;
  });
}

function legacyGeneration(recordingId: unknown, revision: number, committedAt: number): string {
  return `legacy:${typeof recordingId === 'string' ? recordingId : 'unknown'}:${revision}:${committedAt}`;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}
