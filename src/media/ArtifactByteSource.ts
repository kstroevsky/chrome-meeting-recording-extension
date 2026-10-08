import type { PlaybackTrack } from '../shared/playback';

/** Random-access owner bytes, shared by publication and external media transfers. */
export type ArtifactByteSource = {
  readonly size: number;
  read(start: number, end: number, signal?: AbortSignal): Promise<Blob>;
};

export type ArtifactByteSourceResolver = (track: PlaybackTrack) => Promise<ArtifactByteSource>;
