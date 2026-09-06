/**
 * @file background/RecordingPlaybackService.ts
 *
 * Turns a history entry into a playback manifest (ADR-0006).
 *
 * Metadata, source selection and lifecycle only. This service never reads a
 * recording: it tells the player *where* the bytes are and lets the browser's
 * media stack move them. That separation is what keeps a 3 GB recording out of
 * the service worker.
 */

import type { PlaybackManifest, PlaybackSource, PlaybackTrack } from '../shared/playback';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../shared/recordingHistory';
import type { RecordingNotation } from '../shared/notations';

export type RecordingPlaybackServiceDeps = {
  getEntry: (recordingId: string) => Promise<RecordingHistoryEntry | undefined>;
  listNotations: (recordingId: string) => Promise<RecordingNotation[]>;
};

export class RecordingPlaybackService {
  constructor(private readonly deps: RecordingPlaybackServiceDeps) {}

  /** The recording's Drive folder, for re-finding a file whose id went stale. */
  async getFolderId(recordingId: string): Promise<string | undefined> {
    const entry = await this.deps.getEntry(recordingId);
    return entry?.deletedAt ? undefined : entry?.driveFolderId;
  }

  /** Undefined for a missing or tombstoned recording — never a partial manifest. */
  async getManifest(recordingId: string): Promise<PlaybackManifest | undefined> {
    const entry = await this.deps.getEntry(recordingId);
    if (!entry || entry.deletedAt) return undefined;

    // The sidecar is notes, not media. Filtered by `kind` *and* by media type,
    // because rows written before the sidecar carried its own identity can be
    // stored without `kind` and would otherwise arrive as a playable track.
    const media = entry.files.filter((file) => file.kind !== 'notes'
      && (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')));
    return {
      recordingId: entry.id,
      title: entry.name,
      createdAt: entry.createdAt,
      // No transcription pipeline exists yet, so the rail never renders today.
      transcriptStatus: 'none',
      ...(entry.durationMs != null ? { durationMs: entry.durationMs } : {}),
      notations: await this.deps.listNotations(recordingId),
      tracks: media.map(toTrack).sort(byStreamOrder),
    };
  }
}

/** Tab first: it is the master clock, and the player renders it as the picture. */
const STREAM_ORDER = ['tab', 'mic', 'self-video'] as const;
function byStreamOrder(a: PlaybackTrack, b: PlaybackTrack): number {
  return STREAM_ORDER.indexOf(a.stream) - STREAM_ORDER.indexOf(b.stream);
}

function toTrack(file: RecordingHistoryFile): PlaybackTrack {
  return {
    fileId: file.id,
    stream: file.stream,
    filename: file.filename,
    mimeType: file.mimeType,
    ...(file.bytes != null ? { bytes: file.bytes } : {}),
    captureStartOffsetMs: file.captureStartOffsetMs ?? 0,
    sources: toSources(file),
  };
}

/**
 * Preference order, not storage order: OPFS, then Drive, then the Downloads
 * copy — which is carried so the player can offer "open the downloaded file"
 * even though it can never stream it.
 */
function toSources(file: RecordingHistoryFile): PlaybackSource[] {
  const sources: PlaybackSource[] = [];
  for (const location of file.locations) {
    if (location.kind === 'opfs') sources.push({ kind: 'opfs', key: location.key });
  }
  for (const location of file.locations) {
    if (location.kind === 'drive') sources.push({ kind: 'drive', fileId: location.fileId });
  }
  for (const location of file.locations) {
    if (location.kind === 'download') {
      sources.push({ kind: 'download', downloadId: location.downloadId, playableInExtension: false });
    }
  }
  return sources;
}
