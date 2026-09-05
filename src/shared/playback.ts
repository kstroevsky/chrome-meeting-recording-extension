/**
 * @file shared/playback.ts
 *
 * The contract the player reads a recording through (ADR-0006).
 *
 * A manifest carries metadata and *capabilities* only — never media bytes. The
 * player resolves a source itself and hands it to a native media element, so
 * gigabytes never pass through the service worker.
 */

import type { RecordingStream } from './recording';
import type { RecordingNotation } from './notations';

/**
 * Where the player can read a track from, in the order it should try. OPFS is
 * first because the extension owns those bytes; Drive streams natively; a
 * Downloads copy is an external-open fallback, not a transport — `chrome.downloads`
 * exposes no bytes to the extension.
 */
export type PlaybackSource =
  | { kind: 'opfs'; key: string }
  | { kind: 'drive'; fileId: string }
  | { kind: 'download'; downloadId: number; playableInExtension: false };

export type PlaybackTrack = {
  fileId: string;
  stream: RecordingStream;
  filename: string;
  mimeType: string;
  bytes?: number;
  /** Signed offset against the tab/master track; 0 until capture measures it. */
  timelineOffsetMs: number;
  /** Preference-ordered. Empty means the extension can no longer reach this track. */
  sources: PlaybackSource[];
};

/**
 * Drives the player's rail. Always `none` today — nothing produces transcripts
 * yet — but the state is carried so the player branches on data rather than on
 * a feature flag when transcription lands.
 */
export type TranscriptStatus = 'none' | 'processing' | 'ready';

export type PlaybackManifest = {
  recordingId: string;
  title: string;
  createdAt: number;
  durationMs?: number;
  transcriptStatus: TranscriptStatus;
  notations: RecordingNotation[];
  tracks: PlaybackTrack[];
};

/** True for a source the player can actually feed to a media element. */
export function isStreamableSource(source: PlaybackSource): boolean {
  return source.kind === 'opfs' || source.kind === 'drive';
}

/**
 * The track the clock follows: the tab capture when present (ADR-0006 §21).
 *
 * Only ever a track the extension can actually stream. A tab track that exists
 * but has nothing but a Downloads copy is not a master — picking it would fail
 * playback for a recording whose mic track is right there and readable.
 */
export function masterTrack(manifest: PlaybackManifest): PlaybackTrack | undefined {
  const streamable = manifest.tracks.filter((track) => track.sources.some(isStreamableSource));
  return streamable.find((track) => track.stream === 'tab') ?? streamable[0];
}

/** True when nothing in the recording can be played inside the extension. */
export function isPlayable(manifest: PlaybackManifest): boolean {
  return manifest.tracks.some((track) => track.sources.some(isStreamableSource));
}
