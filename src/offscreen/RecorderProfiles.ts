/**
 * @file offscreen/RecorderProfiles.ts
 *
 * MIME, bitrate, and chunking policy helpers for recorder setup.
 */

import { PERF_FLAGS, clamp } from '../shared/perf';
import {
  DEFAULT_EXTENSION_SETTINGS,
  getChunkingSettings,
  getSelfVideoProfileSettings,
} from '../shared/extensionSettings';

export type RecorderChunkStream = 'tab' | 'mic' | 'selfVideo';
export type RecorderVideoContainer = 'webm' | 'mp4';

const DEFAULT_SELF_VIDEO_PROFILE = getSelfVideoProfileSettings(DEFAULT_EXTENSION_SETTINGS);

export const SELF_VIDEO_PROFILE = Object.freeze({
  width: DEFAULT_SELF_VIDEO_PROFILE.width,
  height: DEFAULT_SELF_VIDEO_PROFILE.height,
  frameRate: DEFAULT_SELF_VIDEO_PROFILE.frameRate,
  aspectRatio: DEFAULT_SELF_VIDEO_PROFILE.aspectRatio,
  defaultBitsPerSecond: DEFAULT_SELF_VIDEO_PROFILE.defaultBitsPerSecond,
});

/** Converts a requested self-video profile into strict getUserMedia constraints. */
function buildConstraints(profile: {
  width: number;
  height: number;
  frameRate: number;
  aspectRatio: number;
}): MediaTrackConstraints {
  return {
    resizeMode: 'crop-and-scale' as any,
    aspectRatio: { ideal: profile.aspectRatio },
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
  } as any;
}

/** Converts a requested self-video profile into strict exact-dimensions constraints. */
function buildStrictExactConstraints(profile: {
  width: number;
  height: number;
  frameRate: number;
}): MediaTrackConstraints {
  return {
    resizeMode: 'crop-and-scale' as any,
    width: { exact: profile.width },
    height: { exact: profile.height },
    frameRate: { exact: profile.frameRate },
  } as any;
}

/** Converts a requested self-video profile into strict width/height constraints with flexible FPS. */
function buildStrictSizeConstraints(profile: {
  width: number;
  height: number;
  frameRate: number;
  aspectRatio: number;
}): MediaTrackConstraints {
  return {
    resizeMode: 'crop-and-scale' as any,
    aspectRatio: { ideal: profile.aspectRatio },
    width: { exact: profile.width },
    height: { exact: profile.height },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
  } as any;
}

/** Reads the current self-video profile from normalized extension settings. */
function getCurrentSelfVideoProfile() {
  return getSelfVideoProfileSettings();
}

/** Returns the active self-video profile used for logging and recorder setup. */
export function getSelfVideoProfile() {
  const profile = getCurrentSelfVideoProfile();
  return Object.freeze({
    width: profile.width,
    height: profile.height,
    frameRate: profile.frameRate,
    aspectRatio: profile.aspectRatio,
    defaultBitsPerSecond: profile.defaultBitsPerSecond,
  });
}

/** Returns the active camera constraints derived from the selected preset and frame rate. */
export function getSelfVideoConstraints(): MediaTrackConstraints {
  return buildConstraints(getCurrentSelfVideoProfile());
}

export const SELF_VIDEO_CONSTRAINTS: MediaTrackConstraints = buildConstraints(SELF_VIDEO_PROFILE);

export type SelfVideoConstraintRequest = {
  label: 'exact-size-and-fps' | 'exact-size' | 'best-effort';
  constraints: MediaTrackConstraints;
};

/** Returns the deterministic self-video getUserMedia fallback ladder. */
export function getSelfVideoConstraintRequests(): SelfVideoConstraintRequest[] {
  const profile = getCurrentSelfVideoProfile();

  return [
    {
      label: 'exact-size-and-fps',
      constraints: buildStrictExactConstraints(profile),
    },
    {
      label: 'exact-size',
      constraints: buildStrictSizeConstraints(profile),
    },
    {
      label: 'best-effort',
      constraints: buildConstraints(profile),
    },
  ];
}

/** Returns the minimum bitrate floor used by adaptive self-video bitrate logic. */
function getCurrentSelfVideoMinBitrate(): number {
  return getCurrentSelfVideoProfile().minAdaptiveBitsPerSecond;
}

/** Picks the first browser-supported MediaRecorder MIME from the candidate list. */
function getSupportedMime(...candidates: string[]): string {
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    ?? candidates[candidates.length - 1];
}

/** Returns the first browser-supported MIME or null when no candidate is supported. */
function getSupportedMimeOrNull(...candidates: string[]): string | null {
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null;
}

/** Returns the preferred MIME for tab recordings with video and audio. */
export function getVideoMime(): string {
  return getSupportedMime('video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm');
}

/** Returns the preferred MIME for video-only self-camera recordings. */
export function getVideoOnlyMime(): string {
  return getSupportedMime('video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm');
}

/** Returns the preferred MIME for audio-only microphone recordings. */
export function getAudioMime(): string {
  return getSupportedMime('audio/webm;codecs=opus', 'audio/webm');
}

/** Returns a native MP4 MIME for tab capture when H.264/AAC recording is available. */
export function getNativeTabMp4Mime(): string | null {
  return getSupportedMimeOrNull(
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4'
  );
}

/** Returns a native MP4 MIME for separate camera capture when H.264 recording is available. */
export function getNativeSelfVideoMp4Mime(): string | null {
  return getSupportedMimeOrNull(
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs="avc1.42E01E"',
    'video/mp4'
  );
}

/**
 * Returns the recorder timeslice for one stream.
 *
 * Reliability rule: keep the main tab recorder on the shorter cadence so more
 * data is persisted sooner. The secondary self-video recorder can safely use
 * the longer cadence to reduce OPFS write churn. The mic recorder stays on the
 * shorter cadence unless the perf flag explicitly opts into larger chunks.
 */
export function getChunkTimesliceMs(stream: RecorderChunkStream): number {
  const chunking = getChunkingSettings();
  if (stream === 'tab') return chunking.extendedTimesliceMs;
  if (stream === 'selfVideo') return chunking.extendedTimesliceMs;
  if (PERF_FLAGS.extendedTimeslice) {
    return chunking.extendedTimesliceMs;
  }
  return chunking.defaultTimesliceMs;
}

/** Returns the configured default bitrate ceiling for self-video recordings. */
export function getDefaultSelfVideoBitrate(): number {
  return getCurrentSelfVideoProfile().defaultBitsPerSecond;
}

/** Checks whether the delivered camera track matches the requested preset size. */
export function matchesSelfVideoProfile(settings?: MediaTrackSettings): boolean {
  const profile = getCurrentSelfVideoProfile();
  return settings?.width === profile.width && settings?.height === profile.height;
}

/** Formats the current self-video preset for diagnostics and warnings. */
export function formatSelfVideoProfile(): string {
  const profile = getCurrentSelfVideoProfile();
  return `${profile.width}x${profile.height}`;
}

/** Adapts camera bitrate to the delivered track while respecting configured bounds. */
export function resolveSelfVideoBitrate(
  fallbackBitsPerSecond: number,
  settings?: MediaTrackSettings
): number {
  if (!PERF_FLAGS.adaptiveSelfVideoProfile) return fallbackBitsPerSecond;

  const width = settings?.width;
  const height = settings?.height;
  const frameRate = settings?.frameRate;
  if (!width || !height || !frameRate) return fallbackBitsPerSecond;

  const estimated = Math.round(width * height * frameRate * 0.1);
  return clamp(estimated, getCurrentSelfVideoMinBitrate(), fallbackBitsPerSecond);
}
