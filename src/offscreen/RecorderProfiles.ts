import { PERF_FLAGS, clamp } from '../shared/perf';
import type { MicMode, RecordingRunConfig } from '../shared/recording';

const CHUNK_TIMESLICE_MS = 2000;
const EXTENDED_CHUNK_TIMESLICE_MS = 4000;

export function getVideoMime(): string {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
    return 'video/webm;codecs=vp8,opus';
  }
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';
}

export function getVideoOnlyMime(): string {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'video/webm;codecs=vp8';
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
}

export function getAudioMime(): string {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
}

export function getChunkTimesliceMs(micMode: MicMode, recordSelfVideo: boolean): number {
  if (PERF_FLAGS.extendedTimeslice && (micMode !== 'off' || recordSelfVideo)) {
    return EXTENDED_CHUNK_TIMESLICE_MS;
  }
  return CHUNK_TIMESLICE_MS;
}

export function resolveSelfVideoBitrate(
  quality: RecordingRunConfig['selfVideoQuality'],
  fallbackBitsPerSecond: number,
  settings?: MediaTrackSettings
): number {
  if (!PERF_FLAGS.adaptiveSelfVideoProfile) return fallbackBitsPerSecond;

  const width = settings?.width;
  const height = settings?.height;
  const frameRate = settings?.frameRate;
  if (!width || !height || !frameRate) return fallbackBitsPerSecond;

  const estimated = Math.round(width * height * frameRate * (quality === 'high' ? 0.1 : 0.075));
  const minBitsPerSecond = quality === 'high' ? 1_000_000 : 500_000;
  return clamp(estimated, minBitsPerSecond, fallbackBitsPerSecond);
}
