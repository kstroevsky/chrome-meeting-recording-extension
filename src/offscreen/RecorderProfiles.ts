/**
 * @file offscreen/RecorderProfiles.ts
 *
 * MIME, bitrate, and chunking policy helpers for recorder setup.
 */

import { PERF_FLAGS, clamp } from '../shared/perf';
import type { MicMode } from '../shared/recording';
import { EXTENSION_DEFAULTS } from '../shared/recordingConstants';

const { chunking, capture } = EXTENSION_DEFAULTS;
const SELF_VIDEO_MIN_BITS_PER_SECOND = capture.selfVideo.minAdaptiveBitsPerSecond;

export const SELF_VIDEO_PROFILE = Object.freeze({
  width: capture.selfVideo.width,
  height: capture.selfVideo.height,
  frameRate: capture.selfVideo.frameRate,
  aspectRatio: capture.selfVideo.aspectRatio,
  defaultBitsPerSecond: capture.selfVideo.defaultBitsPerSecond,
});

export const SELF_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  resizeMode: 'crop-and-scale' as any,
  aspectRatio: { ideal: SELF_VIDEO_PROFILE.aspectRatio },
  width: { ideal: SELF_VIDEO_PROFILE.width, max: SELF_VIDEO_PROFILE.width },
  height: { ideal: SELF_VIDEO_PROFILE.height, max: SELF_VIDEO_PROFILE.height },
  frameRate: { ideal: SELF_VIDEO_PROFILE.frameRate, max: SELF_VIDEO_PROFILE.frameRate },
} as any;

function getSupportedMime(...candidates: string[]): string {
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    ?? candidates[candidates.length - 1];
}

export function getVideoMime(): string {
  return getSupportedMime('video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm');
}

export function getVideoOnlyMime(): string {
  return getSupportedMime('video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm');
}

export function getAudioMime(): string {
  return getSupportedMime('audio/webm;codecs=opus', 'audio/webm');
}

export function getChunkTimesliceMs(micMode: MicMode, recordSelfVideo: boolean): number {
  if (PERF_FLAGS.extendedTimeslice && (micMode !== 'off' || recordSelfVideo)) {
    return chunking.extendedTimesliceMs;
  }
  return chunking.defaultTimesliceMs;
}

export function getDefaultSelfVideoBitrate(): number {
  return SELF_VIDEO_PROFILE.defaultBitsPerSecond;
}

export function matchesSelfVideoProfile(settings?: MediaTrackSettings): boolean {
  return settings?.width === SELF_VIDEO_PROFILE.width && settings?.height === SELF_VIDEO_PROFILE.height;
}

export function formatSelfVideoProfile(): string {
  return `${SELF_VIDEO_PROFILE.width}x${SELF_VIDEO_PROFILE.height}`;
}

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
  return clamp(estimated, SELF_VIDEO_MIN_BITS_PER_SECOND, fallbackBitsPerSecond);
}
