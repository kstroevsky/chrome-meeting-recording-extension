/**
 * @file offscreen/RecorderProfiles.ts
 *
 * MIME, bitrate, and chunking policy helpers for recorder setup.
 */

import { PERF_FLAGS, clamp } from '../shared/perf';
import type { MicMode } from '../shared/recording';
import {
  DEFAULT_EXTENSION_SETTINGS,
  getChunkingSettings,
  getSelfVideoProfileSettings,
} from '../shared/extensionSettings';

const DEFAULT_SELF_VIDEO_PROFILE = getSelfVideoProfileSettings(DEFAULT_EXTENSION_SETTINGS);

export const SELF_VIDEO_PROFILE = Object.freeze({
  width: DEFAULT_SELF_VIDEO_PROFILE.width,
  height: DEFAULT_SELF_VIDEO_PROFILE.height,
  frameRate: DEFAULT_SELF_VIDEO_PROFILE.frameRate,
  aspectRatio: DEFAULT_SELF_VIDEO_PROFILE.aspectRatio,
  defaultBitsPerSecond: DEFAULT_SELF_VIDEO_PROFILE.defaultBitsPerSecond,
});

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

function getCurrentSelfVideoProfile() {
  return getSelfVideoProfileSettings();
}

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

export function getSelfVideoConstraints(): MediaTrackConstraints {
  return buildConstraints(getCurrentSelfVideoProfile());
}

export const SELF_VIDEO_CONSTRAINTS: MediaTrackConstraints = buildConstraints(SELF_VIDEO_PROFILE);

function getCurrentSelfVideoMinBitrate(): number {
  return getCurrentSelfVideoProfile().minAdaptiveBitsPerSecond;
}

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
  const chunking = getChunkingSettings();
  if (PERF_FLAGS.extendedTimeslice && (micMode !== 'off' || recordSelfVideo)) {
    return chunking.extendedTimesliceMs;
  }
  return chunking.defaultTimesliceMs;
}

export function getDefaultSelfVideoBitrate(): number {
  return getCurrentSelfVideoProfile().defaultBitsPerSecond;
}

export function matchesSelfVideoProfile(settings?: MediaTrackSettings): boolean {
  const profile = getCurrentSelfVideoProfile();
  return settings?.width === profile.width && settings?.height === profile.height;
}

export function formatSelfVideoProfile(): string {
  const profile = getCurrentSelfVideoProfile();
  return `${profile.width}x${profile.height}`;
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
  return clamp(estimated, getCurrentSelfVideoMinBitrate(), fallbackBitsPerSecond);
}
