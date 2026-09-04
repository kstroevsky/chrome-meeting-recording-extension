/**
 * @file recordings/player/playerTracks.ts
 *
 * What the FILES dropdown and the volume popup are lists *of*.
 *
 * Two rules from the design worth stating, because both are easy to get wrong
 * in the obvious implementation:
 *
 * - A file the recording does not hold is **not rendered**. A recording made
 *   without a camera should not show a greyed-out camera row.
 * - A file that is switched **off stays listed**, so turning it off is
 *   reversible. Only the trigger's count changes.
 */

import type { PlaybackManifest, PlaybackTrack } from '../../shared/playback';
import type { RecordingStream } from '../../shared/recording';

export type TrackDescriptor = {
  fileId: string;
  stream: RecordingStream;
  /** Human label, in the design's wording. */
  label: string;
  /** Short container/codec tag shown beside the label, e.g. `WEBM`. */
  format: string;
  hasVideo: boolean;
  hasAudio: boolean;
  /** False once the user switches it off; the row stays either way. */
  shown: boolean;
};

const LABELS: Record<RecordingStream, string> = {
  tab: 'Tab video',
  'self-video': 'Self camera',
  mic: 'Microphone',
};

/** Order the design lists them in, not the order history happens to store them. */
const ORDER: RecordingStream[] = ['tab', 'self-video', 'mic'];

function formatOf(track: PlaybackTrack): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(track.filename)?.[1];
  if (extension) return extension.toUpperCase();
  return (track.mimeType.split('/')[1] ?? track.mimeType).split(';')[0].toUpperCase();
}

export function describeTracks(
  manifest: PlaybackManifest,
  shown: ReadonlySet<string> | null = null,
): TrackDescriptor[] {
  return [...manifest.tracks]
    .sort((a, b) => ORDER.indexOf(a.stream) - ORDER.indexOf(b.stream))
    .map((track) => ({
      fileId: track.fileId,
      stream: track.stream,
      label: LABELS[track.stream] ?? track.stream,
      format: formatOf(track),
      // The camera is recorded without audio; the tab carries the room.
      hasVideo: track.stream !== 'mic',
      hasAudio: track.stream !== 'self-video',
      shown: shown ? shown.has(track.fileId) : true,
    }));
}

/** What the FILES trigger counts: files currently on, not files that exist. */
export function shownCount(tracks: readonly TrackDescriptor[]): number {
  return tracks.filter((track) => track.shown).length;
}

/** The rows the volume popup gets a fader for. One audio track, one fader. */
export function audioTracks(tracks: readonly TrackDescriptor[]): TrackDescriptor[] {
  return tracks.filter((track) => track.hasAudio);
}

/**
 * Toggling is not allowed to leave nothing playing — the last file on stays on,
 * because an empty player is a worse outcome than a file the user wanted hidden.
 */
export function toggleShown(shown: ReadonlySet<string>, fileId: string): Set<string> {
  const next = new Set(shown);
  if (!next.delete(fileId)) next.add(fileId);
  else if (next.size === 0) next.add(fileId);
  return next;
}
