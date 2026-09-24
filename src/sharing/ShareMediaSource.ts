import type { PlaybackTrack } from '../shared/playback';

/** Random-access owner media used while preparing an immutable Drive origin. */
export type ShareMediaSource = {
  size: number;
  read(start: number, end: number, signal?: AbortSignal): Promise<Blob>;
};

export type ShareMediaSourceResolver = (track: PlaybackTrack) => Promise<ShareMediaSource>;
