/**
 * Output-container policy shared by the settings page and offscreen recorders.
 * The settings page uses the capability probe to disable unavailable choices;
 * recorder tasks use the same resolver immediately before construction.
 */

export type VideoRecordingFormat = 'webm' | 'mp4';
export type MicrophoneRecordingFormat = 'webm' | 'm4a';
export type RecordingFileExtension = 'webm' | 'mp4' | 'm4a';

export type RecordingEncodingProfile = Readonly<{
  format: VideoRecordingFormat | MicrophoneRecordingFormat;
  recorderMimeType: string;
  contentType: string;
  extension: RecordingFileExtension;
}>;

export type RecordingFormatCapabilities = Readonly<{
  tabMp4: boolean;
  cameraMp4: boolean;
  microphoneM4a: boolean;
}>;

type MimeSupport = (mimeType: string) => boolean;

const WEBM_TAB_MIMES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'] as const;
const WEBM_VIDEO_ONLY_MIMES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'] as const;
const WEBM_AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm'] as const;

// Keep broadly compatible H.264/AAC first, then accept the non-proprietary MP4
// combinations Chromium can mux on installations without those encoders.
const MP4_TAB_MIMES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=vp9,opus',
  'video/mp4;codecs=av01,opus',
  'video/mp4',
] as const;
const MP4_VIDEO_ONLY_MIMES = [
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=vp9',
  'video/mp4;codecs=av01',
  'video/mp4',
] as const;
const M4A_AUDIO_MIMES = ['audio/mp4;codecs=mp4a.40.2'] as const;

function browserSupports(mimeType: string): boolean {
  try {
    return typeof MediaRecorder !== 'undefined'
      && typeof MediaRecorder.isTypeSupported === 'function'
      && MediaRecorder.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

function preferredMime(candidates: readonly string[], supports: MimeSupport, allowUnsupportedFallback: boolean): string | null {
  return candidates.find(supports) ?? (allowUnsupportedFallback ? candidates[candidates.length - 1] : null);
}

function profile(
  format: VideoRecordingFormat | MicrophoneRecordingFormat,
  candidates: readonly string[],
  contentType: string,
  extension: RecordingFileExtension,
  supports: MimeSupport,
  allowUnsupportedFallback: boolean,
): RecordingEncodingProfile | null {
  const recorderMimeType = preferredMime(candidates, supports, allowUnsupportedFallback);
  return recorderMimeType ? { format, recorderMimeType, contentType, extension } : null;
}

/** Returns a supported profile for a tab recording, or null for an unavailable MP4 choice. */
export function resolveTabRecordingProfile(
  format: VideoRecordingFormat,
  hasAudio = true,
  supports: MimeSupport = browserSupports,
): RecordingEncodingProfile | null {
  if (format === 'webm') {
    return profile(format, hasAudio ? WEBM_TAB_MIMES : WEBM_VIDEO_ONLY_MIMES, 'video/webm', 'webm', supports, true);
  }
  return profile(format, hasAudio ? MP4_TAB_MIMES : MP4_VIDEO_ONLY_MIMES, 'video/mp4', 'mp4', supports, false);
}

/** Returns a supported profile for a video-only camera recording. */
export function resolveCameraRecordingProfile(
  format: VideoRecordingFormat,
  supports: MimeSupport = browserSupports,
): RecordingEncodingProfile | null {
  if (format === 'webm') {
    return profile(format, WEBM_VIDEO_ONLY_MIMES, 'video/webm', 'webm', supports, true);
  }
  return profile(format, MP4_VIDEO_ONLY_MIMES, 'video/mp4', 'mp4', supports, false);
}

/** Returns a supported profile for a separate microphone recording. */
export function resolveMicrophoneRecordingProfile(
  format: MicrophoneRecordingFormat,
  supports: MimeSupport = browserSupports,
): RecordingEncodingProfile | null {
  if (format === 'webm') {
    return profile(format, WEBM_AUDIO_MIMES, 'audio/webm', 'webm', supports, true);
  }
  return profile(format, M4A_AUDIO_MIMES, 'audio/mp4', 'm4a', supports, false);
}

/** Capability snapshot for the three independently configurable settings controls. */
export function getRecordingFormatCapabilities(
  supports: MimeSupport = browserSupports,
): RecordingFormatCapabilities {
  return {
    // Tab capture requests audio by default. Requiring the audio-bearing profile
    // here keeps the Settings availability check aligned with pre-capture startup
    // validation, rather than enabling MP4 only to fail after a stream is opened.
    tabMp4: !!resolveTabRecordingProfile('mp4', true, supports),
    cameraMp4: !!resolveCameraRecordingProfile('mp4', supports),
    microphoneM4a: !!resolveMicrophoneRecordingProfile('m4a', supports),
  };
}

/** Maps a persisted recording-file extension to its download/upload content type. */
export function contentTypeForRecordingFilename(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'm4a') return 'audio/mp4';
  // The notes sidecar is the one non-media artifact delivered with a recording.
  if (extension === 'vtt') return 'text/vtt';
  return 'video/webm';
}

/** True for formats that require the WebM duration metadata repair step. */
export function isWebmRecordingFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.webm');
}
