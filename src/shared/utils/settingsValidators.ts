/**
 * @file shared/utils/settingsValidators.ts
 *
 * Low-level guard functions for validating individual settings fields.
 * Used by settingsNormalizer.ts to keep per-section validation logic small.
 */

import type { ResolutionPreset } from '../types/settingsTypes';
import type { ChunkingSettings, MicrophoneCaptureSettings, SelfVideoProfileSettings, TabCaptureSettings } from '../types/settingsTypes';

export type BoundedPositiveIntResult = number | null;

/** Validates a number-like value is finite and within [min, max]. */
export function readBoundedPositiveInt(value: unknown, min: number, max: number): BoundedPositiveIntResult {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/** Validates the tab output capture settings section from a snapshot. */
export function validateTabOutput(candidate: Record<string, unknown>): TabCaptureSettings | null {
  const maxWidth = readBoundedPositiveInt(candidate.maxWidth, 1, 10_000);
  const maxHeight = readBoundedPositiveInt(candidate.maxHeight, 1, 10_000);
  const maxFrameRate = readBoundedPositiveInt(candidate.maxFrameRate, 1, 120);
  if (!maxWidth || !maxHeight || !maxFrameRate) return null;
  return { maxWidth, maxHeight, maxFrameRate };
}

/** Validates the self-video profile from a recorder settings snapshot. */
export function validateSelfVideoProfile(candidate: Record<string, unknown>): SelfVideoProfileSettings | null {
  const width = readBoundedPositiveInt(candidate.width, 1, 10_000);
  const height = readBoundedPositiveInt(candidate.height, 1, 10_000);
  const frameRate = readBoundedPositiveInt(candidate.frameRate, 1, 120);
  const defaultBitsPerSecond = readBoundedPositiveInt(candidate.defaultBitsPerSecond, 100_000, 50_000_000);
  const minAdaptiveBitsPerSecond = readBoundedPositiveInt(candidate.minAdaptiveBitsPerSecond, 100_000, 50_000_000);
  const aspectRatio =
    typeof candidate.aspectRatio === 'number'
    && Number.isFinite(candidate.aspectRatio)
    && candidate.aspectRatio > 0
      ? candidate.aspectRatio
      : null;

  if (
    !width || !height || !frameRate || !defaultBitsPerSecond
    || !minAdaptiveBitsPerSecond || aspectRatio == null
    || minAdaptiveBitsPerSecond > defaultBitsPerSecond
  ) {
    return null;
  }

  return { width, height, frameRate, aspectRatio, defaultBitsPerSecond, minAdaptiveBitsPerSecond };
}

/** Validates the microphone capture settings section from a snapshot. */
export function validateMicrophoneSettings(candidate: Record<string, unknown>): MicrophoneCaptureSettings | null {
  const echoCancellation = typeof candidate.echoCancellation === 'boolean' ? candidate.echoCancellation : null;
  const noiseSuppression = typeof candidate.noiseSuppression === 'boolean' ? candidate.noiseSuppression : null;
  const autoGainControl = typeof candidate.autoGainControl === 'boolean' ? candidate.autoGainControl : null;
  if (echoCancellation == null || noiseSuppression == null || autoGainControl == null) return null;
  return { echoCancellation, noiseSuppression, autoGainControl };
}

/** Validates the chunking timeslice settings section from a snapshot. */
export function validateChunkingSettings(candidate: Record<string, unknown>): ChunkingSettings | null {
  const defaultTimesliceMs = readBoundedPositiveInt(candidate.defaultTimesliceMs, 250, 60_000);
  const extendedTimesliceMs = readBoundedPositiveInt(candidate.extendedTimesliceMs, 250, 60_000);
  if (!defaultTimesliceMs || !extendedTimesliceMs || extendedTimesliceMs < defaultTimesliceMs) return null;
  return { defaultTimesliceMs, extendedTimesliceMs };
}
