/**
 * @file offscreen/postprocessor/VideoPlaybackElement.ts
 *
 * DOM helpers for the hidden HTMLVideoElement used during tab artifact
 * postprocessing. Keeps element setup and teardown away from the main
 * postprocessor pipeline.
 */

import { withTimeout } from '../../shared/async';
import { TIMEOUTS } from '../../shared/timeouts';

/** Configures a video element for hidden, muted, manual-play offscreen use. */
export function preparePlaybackElement(video: HTMLVideoElement): void {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = false;
  video.hidden = true;
  video.preload = 'auto';
  video.style.position = 'fixed';
  video.style.left = '-99999px';
  video.style.top = '-99999px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
}

/** Resolves once the video element exposes dimensions, or rejects on error. */
export async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Tab postprocess video metadata could not be loaded'));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onError);
    }),
    TIMEOUTS.GUM_MS,
    'tab postprocess metadata'
  );
}

/** Waits for a MediaRecorder to fire `onstart` with a hard timeout guard. */
export async function waitForRecorderStart(recorder: MediaRecorder): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Tab postprocess MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        resolve();
      };
    }),
    TIMEOUTS.RECORDER_START_MS + 100,
    'tab postprocess recorder start'
  );
}

/** Best-effort removal of a temporary OPFS file without surfacing NotFoundError. */
export async function cleanupTempOpfsFile(filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(filename);
  } catch (error: any) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

/** Stops all tracks in a stream without surfacing errors. */
export function stopStream(stream: MediaStream | null): void {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {}
}

/** Formats resolution and frame rate into a compact human-readable label. */
export function formatMetrics(width?: number, height?: number, frameRate?: number): string {
  const resolution =
    typeof width === 'number' && typeof height === 'number'
      ? `${width}x${height}`
      : 'unknown resolution';
  const fps = typeof frameRate === 'number' ? `@${Math.round(frameRate * 10) / 10}fps` : '';
  return `${resolution}${fps}`;
}
