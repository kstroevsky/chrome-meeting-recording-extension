import { normalizeTranscript, type Transcript } from './transcript';

export const TRANSCRIPT_SCHEMA_VERSION = 1;

export type TranscriptIdentity = {
  revision: number;
  contentHash: string;
};

export type TranscriptSnapshot = TranscriptIdentity & {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
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
    normalized.source,
    normalized.segments.map((segment) => [
      segment.tStartMs,
      segment.tEndMs,
      segment.speaker ?? null,
      segment.text,
    ]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
