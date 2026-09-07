/**
 * @file shared/settings/validate.ts
 *
 * Low-level guard functions for validating individual settings fields.
 * Used by normalize.ts to keep per-section validation logic small. Internal to
 * the Settings module.
 */

import type { ChunkingSettings, FolderPreset, MicrophoneCaptureSettings, SelfVideoProfileSettings, TabCaptureSettings, TabContentType } from './model';
import type { MicrophoneRecordingFormat, VideoRecordingFormat } from '../recordingFormats';

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
  // Lenient ('screen' default) so a snapshot from an older build still validates.
  const contentType: TabContentType = candidate.contentType === 'video' ? 'video' : 'screen';
  const format: VideoRecordingFormat = candidate.format === 'mp4' ? 'mp4' : 'webm';
  return { maxWidth, maxHeight, maxFrameRate, format, contentType };
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

  // Lenient (default false) so a snapshot from an older build still validates.
  const autoResolution = typeof candidate.autoResolution === 'boolean' ? candidate.autoResolution : false;
  const format: VideoRecordingFormat = candidate.format === 'mp4' ? 'mp4' : 'webm';
  return { width, height, frameRate, format, aspectRatio, defaultBitsPerSecond, minAdaptiveBitsPerSecond, autoResolution };
}

/** Validates the microphone capture settings section from a snapshot. */
export function validateMicrophoneSettings(candidate: Record<string, unknown>): MicrophoneCaptureSettings | null {
  const echoCancellation = typeof candidate.echoCancellation === 'boolean' ? candidate.echoCancellation : null;
  const noiseSuppression = typeof candidate.noiseSuppression === 'boolean' ? candidate.noiseSuppression : null;
  const autoGainControl = typeof candidate.autoGainControl === 'boolean' ? candidate.autoGainControl : null;
  if (echoCancellation == null || noiseSuppression == null || autoGainControl == null) return null;
  const format: MicrophoneRecordingFormat = candidate.format === 'm4a' ? 'm4a' : 'webm';
  return { echoCancellation, noiseSuppression, autoGainControl, format };
}

/** Validates the chunking timeslice settings section from a snapshot. */
export function validateChunkingSettings(candidate: Record<string, unknown>): ChunkingSettings | null {
  const defaultTimesliceMs = readBoundedPositiveInt(candidate.defaultTimesliceMs, 250, 60_000);
  const extendedTimesliceMs = readBoundedPositiveInt(candidate.extendedTimesliceMs, 250, 60_000);
  if (!defaultTimesliceMs || !extendedTimesliceMs || extendedTimesliceMs < defaultTimesliceMs) return null;
  return { defaultTimesliceMs, extendedTimesliceMs };
}

/**
 * Sanitizes the user's Drive destinations.
 *
 * A preset name becomes a real Drive folder name, so it is trimmed, length-
 * capped and stripped of the characters that make a folder awkward to address.
 * Duplicates are collapsed case-insensitively: two destinations that resolve to
 * the same folder are one destination with two labels, and the picker would be
 * lying.
 */
/**
 * Drive names only have to survive being a Drive folder title, so slashes and
 * control characters are the whole hazard.
 */
const DRIVE_FORBIDDEN = /[\\/\u0000-\u001f]/g;

/**
 * Local names become a real path segment under the download directory, so they
 * also lose the characters Windows cannot represent. Chrome sanitises again on
 * its side; this keeps the *stored* name honest about what the user will see.
 */
const LOCAL_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeFolderName(raw: unknown, maxLength: number, forbidden: RegExp): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(forbidden, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot is legal to type and invalid as a Windows directory.
    .replace(/\.+$/, '')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function validatePresets(
  value: unknown,
  limits: { maxPresets: number; maxNameLength: number },
  forbidden: RegExp,
): FolderPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: FolderPreset[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as { id?: unknown; name?: unknown };
    const name = sanitizeFolderName(raw.name, limits.maxNameLength, forbidden);
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
    if (!name || !id) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ id, name });
    if (presets.length >= limits.maxPresets) break;
  }
  return presets;
}

export function validateDriveFolderPresets(
  value: unknown,
  limits: { maxPresets: number; maxNameLength: number },
): FolderPreset[] {
  return validatePresets(value, limits, DRIVE_FORBIDDEN);
}

/** Same shape as the Drive list, stricter about what a path segment may contain. */
export function validateLocalFolderPresets(
  value: unknown,
  limits: { maxPresets: number; maxNameLength: number },
): FolderPreset[] {
  return validatePresets(value, limits, LOCAL_FORBIDDEN);
}
