/**
 * @file shared/sharing.ts
 *
 * Public playback contract for a published share. This is intentionally a
 * different type from PlaybackManifest: OPFS keys, Drive file ids, Downloads
 * ids and owner-side recording ids must never cross the sharing boundary.
 */

import type { RecordingNotation } from './notations';
import type { PlaybackManifest, PlaybackTopic } from './playback';
import type { RecordingStream } from './recording';
import type { Transcript } from './transcript';

export type SharedPlaybackTrack = {
  /** Opaque id minted for the published snapshot. */
  id: string;
  stream: RecordingStream;
  mimeType: string;
  bytes?: number;
  captureStartOffsetMs: number;
  /** Authorization-gated media endpoint. Never an object-storage key. */
  mediaEndpoint: string;
};

export type SharedRecording = {
  /** Opaque published id, distinct from the owner's recording/history id. */
  id: string;
  title: string;
  createdAt: number;
  durationMs?: number;
  tracks: SharedPlaybackTrack[];
  transcript?: Transcript;
  topics?: PlaybackTopic[];
  notations?: RecordingNotation[];
  /** UI permission only; receiving bytes is never DRM. */
  downloadsEnabled: boolean;
};

export type PublishedPlaybackManifest = {
  /** Opaque share id; authorization still comes from the share capability/session. */
  id: string;
  createdAt: number;
  recordings: SharedRecording[];
};

/**
 * Adapts a public recording to the existing synchronized player contract.
 * The generated filenames are presentation-only and cannot reveal owner-side
 * names or storage identifiers.
 */
export function sharedRecordingToPlaybackManifest(recording: SharedRecording): PlaybackManifest {
  return {
    recordingId: recording.id,
    title: recording.title,
    createdAt: recording.createdAt,
    ...(recording.durationMs != null ? { durationMs: recording.durationMs } : {}),
    transcriptStatus: recording.transcript ? 'ready' : 'none',
    notations: recording.notations ?? [],
    topics: recording.topics ?? [],
    tracks: recording.tracks.map((track) => ({
      fileId: track.id,
      stream: track.stream,
      filename: `${track.stream}.${extensionForMimeType(track.mimeType)}`,
      mimeType: track.mimeType,
      ...(track.bytes != null ? { bytes: track.bytes } : {}),
      captureStartOffsetMs: track.captureStartOffsetMs,
      sources: [{ kind: 'remote', url: track.mediaEndpoint }],
    })),
  };
}

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split(';', 1)[0]?.split('/')[1]?.trim().toLowerCase();
  if (!subtype) return 'media';
  if (subtype === 'x-m4a') return 'm4a';
  return subtype.replace(/[^a-z0-9]+/g, '-') || 'media';
}
