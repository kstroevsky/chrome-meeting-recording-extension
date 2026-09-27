import { normalizeTranscript, type Transcript } from './transcript';

export const TRANSCRIPT_SCHEMA_VERSION = 1;
/** Version of the exact tuple encoding hashed below. */
export const TRANSCRIPT_CANONICALIZATION_VERSION = 2;

export type TranscriptIdentity = {
  /** Non-reused mutation token; fences delete/recreate ABA even if revision restarts. */
  generation: string;
  revision: number;
  contentHash: string;
};

export type TranscriptSnapshot = TranscriptIdentity & {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  canonicalizationVersion: typeof TRANSCRIPT_CANONICALIZATION_VERSION;
  committedAt: number;
  transcript: Transcript;
};

/**
 * Hashes the canonical transcript payload. The fixed tuple representation keeps
 * ordering explicit and avoids depending on object property order.
 */
export async function hashTranscript(transcript: Transcript): Promise<string> {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) throw new Error('Cannot fingerprint an invalid transcript');

  const canonical = JSON.stringify([
    TRANSCRIPT_SCHEMA_VERSION,
    TRANSCRIPT_CANONICALIZATION_VERSION,
    normalized.source,
    normalized.segments.map((segment) => [
      segment.tStartMs,
      segment.tEndMs,
      segment.text,
      segment.speaker ?? null,
    ]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
