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
  /** Protected HTTP endpoint returned by the sharing service. */
  | { kind: 'remote'; url: string }
  | { kind: 'download'; downloadId: number; playableInExtension: false };

export type PlaybackTrack = {
  fileId: string;
  stream: RecordingStream;
  filename: string;
  mimeType: string;
  bytes?: number;
  /** Signed offset against the tab/master track; 0 until capture measures it. */
  /** Milliseconds after the run started that this track's recorder began. */
  captureStartOffsetMs: number;
  /** Preference-ordered. Empty means the extension can no longer reach this track. */
  sources: PlaybackSource[];
};

/**
 * Drives the player's rail, from the stored transcript aggregate (ADR-0007).
 *
 * Real since Phase 0 landed: `RecordingTranscriptService.status` answers it, so
 * a recording captured with Meet captions on reports `ready` and one without
 * reports `none`. The player branches on this rather than on a feature flag.
 */
export type TranscriptStatus = 'none' | 'processing' | 'ready';

/**
 * One topic, as the player reads it (ADR-0007, UI-02).
 *
 * **Carries its spans rather than one range**, because a topic is *global* and
 * a span is *temporal* (MODEL-01, MODEL-05): a meeting that returns to Redis
 * after twenty minutes of hiring is one topic with two spans, and flattening it
 * to a single start-to-end range would claim the hiring discussion was Redis.
 * The scrub band draws the spans; the TOPICS list shows one row per topic.
 *
 * Deliberately free of vectors. Centroids and segment embeddings stay in the
 * `analyses` store where the retrieval work will want them (QRY-01); the player
 * needs words and offsets and would only be made heavier by the rest.
 */
export type PlaybackTopic = {
  id: string;
  /** Label terms, strongest first — what UI-02 renders as `redis · timeout · pool`. */
  keywords: string[];
  /** Every stretch of media this topic covers, in time order. Never empty. */
  spans: Array<{ tStartMs: number; tEndMs: number }>;
  /** Summed across `spans` — the `23 min` in UI-02's list, not last minus first. */
  totalMs: number;
  /** Relative standing among this recording's topics, in [0, 1]. */
  importance: number;
};

export type PlaybackManifest = {
  recordingId: string;
  title: string;
  createdAt: number;
  durationMs?: number;
  transcriptStatus: TranscriptStatus;
  notations: RecordingNotation[];
  /**
   * Empty when the recording has no current analysis — never analysed, still
   * running, or analysed under conditions that no longer apply. The player
   * renders topics when there are some and stays out of the way when there are
   * none, which is the same branch for all three.
   */
  topics: PlaybackTopic[];
  tracks: PlaybackTrack[];
};

/** Where picking a topic seeks to: the start of its first span. */
export function topicSeekMs(topic: PlaybackTopic): number {
  return topic.spans[0]?.tStartMs ?? 0;
}

/** True for a source the player can actually feed to a media element. */
export function isStreamableSource(source: PlaybackSource): boolean {
  return source.kind === 'opfs' || source.kind === 'drive' || source.kind === 'remote';
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

/** What the retained library costs, and what the browser reports about it. */
export type StorageUsage = {
  /** Whether a StorageManager persistence grant is held. Not a durability signal
   *  for an extension: `unlimitedStorage` is what exempts OPFS from eviction. */
  persisted: boolean;
  /** Bytes this origin uses across OPFS and IndexedDB; absent if unavailable. */
  usageBytes?: number;
  quotaBytes?: number;
  /** Bytes the retained library holds — what a cleanup would free. */
  retainedBytes: number;
};
