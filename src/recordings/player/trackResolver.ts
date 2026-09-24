import type { PlaybackTrack } from '../../shared/playback';

/** A media-element URL resolved outside the synchronized player core. */
export type ResolvedTrackUrl = {
  url: string;
  revoke?: () => void;
  /** Optional recovery path for an expired or otherwise replaceable URL. */
  refresh?: () => Promise<ResolvedTrackUrl | undefined>;
};

/**
 * Platform adapter used by the player. Extension storage/auth and web sharing
 * authorization live behind this seam rather than in PlayerController.
 */
export type TrackUrlResolver = (
  recordingId: string,
  track: PlaybackTrack,
) => Promise<ResolvedTrackUrl | undefined>;
