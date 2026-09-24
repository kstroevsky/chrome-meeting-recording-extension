/**
 * @file sharing/PublishedManifestBuilder.ts
 *
 * Builds the owner-side publishing plan for one immutable recording snapshot.
 * `recording` is safe to send to a viewer. `tracks` stays inside the extension
 * and tells the upload layer which private source track backs each public id.
 */

import type { PlaybackManifest, PlaybackTrack } from '../shared/playback';
import type { PublishedPlaybackManifest, SharedPlaybackTrack, SharedRecording } from '../shared/sharing';
import type { Transcript } from '../shared/transcript';

export type PublishRecordingOptions = {
  includeTranscript?: boolean;
  includeTopics?: boolean;
  includeNotations?: boolean;
  includeSelfVideo?: boolean;
  downloadsEnabled?: boolean;
};

export type PublishedTrackPlan = {
  /** Owner-private source. Never serialize this into the viewer manifest. */
  source: PlaybackTrack;
  published: SharedPlaybackTrack;
};

export type PublishedRecordingPlan = {
  /** Owner-private id used to associate upload/progress state with history. */
  sourceRecordingId: string;
  /** Sanitized snapshot that may cross the sharing boundary. */
  recording: SharedRecording;
  tracks: PublishedTrackPlan[];
};

export type PublishedManifestBuilderDeps = {
  newId?: () => string;
  mediaEndpoint?: (recordingId: string, trackId: string) => string;
};

export type ShareManifestBuilderDeps = {
  newId?: () => string;
  now?: () => number;
};

export type PublishedRecordingInput = {
  manifest: PlaybackManifest;
  transcript?: Transcript;
};

const DEFAULTS: Required<PublishRecordingOptions> = {
  includeTranscript: true,
  includeTopics: true,
  includeNotations: false,
  includeSelfVideo: false,
  downloadsEnabled: false,
};

/**
 * Creates a snapshot and the private upload mapping in one pass so identifiers
 * cannot drift between metadata and media jobs.
 */
export function buildPublishedRecording(
  input: PublishedRecordingInput,
  options: PublishRecordingOptions = {},
  deps: PublishedManifestBuilderDeps = {},
): PublishedRecordingPlan {
  const config = { ...DEFAULTS, ...options };
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const recordingId = newId();
  const mediaEndpoint = deps.mediaEndpoint ?? ((publishedRecordingId, trackId) =>
    `/media/recordings/${encodeURIComponent(publishedRecordingId)}/tracks/${encodeURIComponent(trackId)}`);

  const sourceTracks = input.manifest.tracks.filter((track) => config.includeSelfVideo || track.stream !== 'self-video');
  const tracks = sourceTracks.map((source): PublishedTrackPlan => {
    const id = newId();
    const published: SharedPlaybackTrack = {
      id,
      stream: source.stream,
      mimeType: source.mimeType,
      ...(source.bytes != null ? { bytes: source.bytes } : {}),
      captureStartOffsetMs: source.captureStartOffsetMs,
      mediaEndpoint: mediaEndpoint(recordingId, id),
    };
    return { source, published };
  });

  const includeTranscript = config.includeTranscript && input.transcript != null;
  const includeTopics = includeTranscript && config.includeTopics;
  const recording: SharedRecording = {
    id: recordingId,
    title: input.manifest.title,
    createdAt: input.manifest.createdAt,
    ...(input.manifest.durationMs != null ? { durationMs: input.manifest.durationMs } : {}),
    tracks: tracks.map((track) => track.published),
    ...(includeTranscript ? { transcript: clone(input.transcript!) } : {}),
    ...(includeTopics ? { topics: clone(input.manifest.topics) } : {}),
    ...(config.includeNotations ? { notations: clone(input.manifest.notations) } : {}),
    downloadsEnabled: config.downloadsEnabled,
  };

  return { sourceRecordingId: input.manifest.recordingId, recording, tracks };
}

/** One revocable share may contain several immutable recording snapshots. */
export function buildPublishedManifest(
  recordings: readonly PublishedRecordingPlan[],
  deps: ShareManifestBuilderDeps = {},
): PublishedPlaybackManifest {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  return {
    id: newId(),
    createdAt: now(),
    recordings: recordings.map((plan) => clone(plan.recording)),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
