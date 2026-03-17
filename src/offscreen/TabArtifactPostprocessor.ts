/**
 * @file offscreen/TabArtifactPostprocessor.ts
 *
 * Post-stop video delivery processing for tab and self-video artifacts. This
 * can resize tab recordings and/or convert WebM masters into native MP4 when
 * the runtime supports the requested MediaRecorder MIME.
 */

import { withTimeout } from '../shared/async';
import type { RecordingStream } from '../shared/recording';
import type { ChunkingSettings } from '../shared/extensionSettings';
import { TIMEOUTS } from '../shared/timeouts';
import { LocalFileTarget } from './LocalFileTarget';
import {
  getNativeSelfVideoMp4Mime,
  getNativeTabMp4Mime,
  getVideoMime,
  getVideoOnlyMime,
  type RecorderVideoContainer,
} from './RecorderProfiles';
import { describeMediaError } from './RecorderSupport';
import { createResizedVideoStream, readStreamVideoMetrics, type VideoResizeTarget } from './RecorderVideoResizer';
import type { SealedStorageFile } from './RecorderEngine';

export type VideoArtifactPostprocessPlan = {
  stream: Extract<RecordingStream, 'tab' | 'selfVideo'>;
  outputContainer: RecorderVideoContainer;
  outputTarget?: VideoResizeTarget;
  chunking: ChunkingSettings;
};

type VideoArtifactPostprocessorDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

class InMemoryStorageTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;

  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
  ) {}

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory postprocess target is closed');
    this.chunks.push(chunk);
  }

  async close(): Promise<SealedStorageFile | null> {
    if (this.closed) return null;
    this.closed = true;
    if (!this.chunks.length) return null;

    return {
      filename: this.filename,
      file: new File([new Blob(this.chunks, { type: this.mimeType })], this.filename, {
        type: this.mimeType,
      }),
      cleanup: async () => {},
    };
  }
}

function preparePlaybackElement(video: HTMLVideoElement): void {
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

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Video postprocess metadata could not be loaded'));
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onError);
    }),
    TIMEOUTS.GUM_MS,
    'video postprocess metadata'
  );
}

async function waitForRecorderStart(recorder: MediaRecorder): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(
        () => reject(new Error('Video postprocess MediaRecorder did not start (timeout)')),
        TIMEOUTS.RECORDER_START_MS
      );

      recorder.onstart = () => {
        clearTimeout(startTimeout);
        resolve();
      };
    }),
    TIMEOUTS.RECORDER_START_MS + 100,
    'video postprocess recorder start'
  );
}

async function cleanupTempOpfsFile(filename: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(filename);
  } catch (error: any) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

function stopStream(stream: MediaStream | null): void {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {}
}

function formatMetrics(width?: number, height?: number, frameRate?: number): string {
  const resolution =
    typeof width === 'number' && typeof height === 'number'
      ? `${width}x${height}`
      : 'unknown resolution';
  const fps = typeof frameRate === 'number' ? `@${Math.round(frameRate * 10) / 10}fps` : '';
  return `${resolution}${fps}`;
}

function replaceExtension(filename: string, extension: '.webm' | '.mp4'): string {
  return filename.replace(/\.[^.]+$/u, extension);
}

function resolveOutputMime(plan: VideoArtifactPostprocessPlan): string {
  if (plan.outputContainer === 'mp4') {
    const mime = plan.stream === 'tab' ? getNativeTabMp4Mime() : getNativeSelfVideoMp4Mime();
    if (!mime) {
      throw new Error(
        plan.stream === 'tab'
          ? 'Tab MP4 delivery is not supported in this Chrome runtime'
          : 'Camera MP4 delivery is not supported in this Chrome runtime'
      );
    }
    return mime;
  }

  return plan.stream === 'selfVideo' ? getVideoOnlyMime() : getVideoMime();
}

/**
 * Replays one sealed video artifact and returns a replacement file at the
 * requested container and optional resize target.
 */
export async function postprocessVideoArtifact(
  artifact: SealedStorageFile,
  plan: VideoArtifactPostprocessPlan,
  deps: VideoArtifactPostprocessorDeps
): Promise<SealedStorageFile> {
  const mimeType = resolveOutputMime(plan);
  const extension = plan.outputContainer === 'mp4' ? '.mp4' : '.webm';
  const finalFilename = replaceExtension(artifact.filename, extension);
  const tempFilename = `video-postprocess-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
  const inputUrl = URL.createObjectURL(artifact.file);
  let playbackVideo: HTMLVideoElement | null = null;
  let playbackStream: MediaStream | null = null;
  let processedStream: MediaStream | null = null;
  let cleanupProcessedStream: (() => void) | null = null;
  let usingOpfsTarget = false;
  let outputTarget: LocalFileTarget | InMemoryStorageTarget | null = null;

  try {
    playbackVideo = document.createElement('video');
    preparePlaybackElement(playbackVideo);
    playbackVideo.src = inputUrl;
    await waitForVideoMetadata(playbackVideo);

    await playbackVideo.play();
    const capturePlayback = (playbackVideo as HTMLVideoElement & {
      captureStream?: () => MediaStream;
    }).captureStream;
    if (typeof capturePlayback !== 'function') {
      throw new Error('HTMLVideoElement.captureStream() is unavailable for video postprocess');
    }

    playbackStream = capturePlayback.call(playbackVideo);
    if (!playbackStream.getVideoTracks().length) {
      throw new Error('Playback capture did not produce a video track for video postprocess');
    }

    if (plan.outputTarget) {
      const resized = await createResizedVideoStream(playbackStream, plan.outputTarget);
      processedStream = resized.stream;
      cleanupProcessedStream = resized.cleanup;
      const processedMetrics = readStreamVideoMetrics(processedStream);
      const target = plan.outputTarget;
      if (
        processedMetrics.width !== target.width
        || processedMetrics.height !== target.height
        || (
          typeof processedMetrics.frameRate === 'number'
          && processedMetrics.frameRate > target.frameRate + 0.5
        )
      ) {
        throw new Error(
          `Video postprocess produced ${formatMetrics(
            processedMetrics.width,
            processedMetrics.height,
            processedMetrics.frameRate
          )} instead of ${formatMetrics(target.width, target.height, target.frameRate)}`
        );
      }
    } else {
      processedStream = playbackStream;
    }

    playbackVideo.pause();
    try { playbackVideo.currentTime = 0; } catch {}

    try {
      outputTarget = await LocalFileTarget.create(tempFilename);
      usingOpfsTarget = true;
    } catch (error) {
      deps.warn(
        'Failed to open postprocess storage target, falling back to RAM buffer',
        describeMediaError(error)
      );
      outputTarget = new InMemoryStorageTarget(tempFilename, mimeType);
    }

    const recorderOptions: MediaRecorderOptions = {
      mimeType,
      videoBitsPerSecond: 1_500_000,
    };
    if (processedStream.getAudioTracks().length > 0) {
      recorderOptions.audioBitsPerSecond = 96_000;
    }
    const recorder = new MediaRecorder(processedStream, recorderOptions);

    let writeFailed = false;
    const processedArtifactPromise = new Promise<SealedStorageFile>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = async () => {
        if (settled) return;
        settled = true;
        try {
          const sealed = await outputTarget!.close();
          if (!sealed) {
            reject(new Error('Video postprocess produced no output artifact'));
            return;
          }
          resolve({
            ...sealed,
            filename: finalFilename,
          });
        } catch (error) {
          reject(error);
        }
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data?.size) return;
        void outputTarget!.write(event.data).catch((error) => {
          writeFailed = true;
          fail(new Error(`Video postprocess write failed: ${describeMediaError(error)}`));
        });
      };

      recorder.onerror = (event: any) => {
        fail(new Error(`Video postprocess MediaRecorder failed: ${describeMediaError(event)}`));
      };

      recorder.onstop = () => {
        if (writeFailed) return;
        void succeed();
      };

      playbackVideo!.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (error) { fail(error); }
        }
      }, { once: true });
    });

    const startPromise = waitForRecorderStart(recorder);
    recorder.start(plan.chunking.defaultTimesliceMs);
    await startPromise;
    await playbackVideo.play();
    const processedArtifact = await processedArtifactPromise;
    while (recorder.state !== 'inactive') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      await artifact.cleanup();
    } catch (error) {
      deps.warn(
        'Failed to cleanup original artifact after postprocess',
        artifact.filename,
        describeMediaError(error)
      );
    }

    deps.log('video artifact postprocess complete:', {
      sourceFilename: artifact.filename,
      finalFilename,
      outputContainer: plan.outputContainer,
      targetWidth: plan.outputTarget?.width,
      targetHeight: plan.outputTarget?.height,
      targetFrameRate: plan.outputTarget?.frameRate,
      stream: plan.stream,
    });
    return processedArtifact;
  } catch (error) {
    if (usingOpfsTarget) {
      try {
        await cleanupTempOpfsFile(tempFilename);
      } catch (cleanupError) {
        deps.warn('Failed to cleanup temporary postprocess file', tempFilename, describeMediaError(cleanupError));
      }
    }
    throw error;
  } finally {
    cleanupProcessedStream?.();
    stopStream(playbackStream);
    if (processedStream && processedStream !== playbackStream) {
      stopStream(processedStream);
    }
    if (playbackVideo) {
      try { playbackVideo.pause(); } catch {}
      playbackVideo.src = '';
      playbackVideo.load();
    }
    URL.revokeObjectURL(inputUrl);
  }
}
