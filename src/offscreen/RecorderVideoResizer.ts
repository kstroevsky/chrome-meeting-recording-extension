/**
 * @file offscreen/RecorderVideoResizer.ts
 *
 * Live tab-video downscaling so the recorder input matches the selected
 * output preset without running a post-stop transcode.
 */

import { withTimeout } from '../shared/async';
import { TIMEOUTS } from '../shared/timeouts';

export type VideoResizeTarget = {
  width: number;
  height: number;
  frameRate: number;
};

export type StreamVideoMetrics = {
  width: number | undefined;
  height: number | undefined;
  frameRate: number | undefined;
};

type VideoElementLike = {
  srcObject: MediaStream | null;
  muted: boolean;
  playsInline: boolean;
  autoplay: boolean;
  hidden?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  videoWidth: number;
  videoHeight: number;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => void;
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type CanvasContextLike = {
  drawImage: (...args: any[]) => void;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: ImageSmoothingQuality;
};

type CanvasElementLike = {
  width: number;
  height: number;
  hidden?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  getContext: (contextId: '2d', options?: CanvasRenderingContext2DSettings) => CanvasContextLike | null;
  captureStream: (frameRate?: number) => MediaStream;
};

type DocumentLike = {
  createElement: (tagName: 'video' | 'canvas') => VideoElementLike | CanvasElementLike;
};

export type ResizedVideoStream = {
  stream: MediaStream;
  resized: boolean;
  source: StreamVideoMetrics;
  output: StreamVideoMetrics;
  cleanup: () => void;
};

export type RecorderVideoResizerDeps = {
  document?: DocumentLike;
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

/** Reads the current width, height, and frame rate reported by a stream's first video track. */
export function readStreamVideoMetrics(stream: MediaStream): StreamVideoMetrics {
  const settings = stream.getVideoTracks()[0]?.getSettings?.();
  return {
    width: typeof settings?.width === 'number' ? settings.width : undefined,
    height: typeof settings?.height === 'number' ? settings.height : undefined,
    frameRate: typeof settings?.frameRate === 'number' ? settings.frameRate : undefined,
  };
}

/** Returns true when a measured source is already at or below the requested output target. */
function isAtOrBelowTarget(metrics: StreamVideoMetrics, target: VideoResizeTarget): boolean {
  const frameRateFits =
    typeof metrics.frameRate !== 'number'
    || metrics.frameRate <= target.frameRate + 0.5;

  return !!metrics.width
    && !!metrics.height
    && metrics.width <= target.width
    && metrics.height <= target.height
    && frameRateFits;
}

/** Configures a media-backed video element for offscreen rendering only. */
function prepareVideoElement(video: VideoElementLike): void {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.hidden = true;

  if (!video.style) return;
  video.style.position = 'fixed';
  video.style.left = '-99999px';
  video.style.top = '-99999px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
}

/** Clears a temporary media element without surfacing teardown failures. */
function cleanupVideoElement(video: VideoElementLike): void {
  try {
    video.pause();
  } catch {}

  try {
    video.srcObject = null;
  } catch {}
}

/** Stops every track in an internally created stream. */
function stopStream(stream: MediaStream | null): void {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {}
}

/** Resolves once the source video exposes dimensions so the resizer can size the canvas correctly. */
async function waitForVideoMetadata(
  video: VideoElementLike
): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return;

  await withTimeout(new Promise<void>((resolve, reject) => {
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Tab resize video metadata could not be loaded'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('error', onError);
  }), TIMEOUTS.GUM_MS, 'tab resize metadata');
}

/** Creates a combined stream from one resized video track plus the original audio tracks. */
function createCombinedStream(
  tracks: MediaStreamTrack[],
  deps: RecorderVideoResizerDeps
): MediaStream {
  if (deps.createMediaStream) return deps.createMediaStream(tracks);
  return new MediaStream(tracks);
}

/** Draws video frames into a canvas stream when the target preset is smaller than the source. */
export async function createResizedVideoStream(
  sourceStream: MediaStream,
  target: VideoResizeTarget,
  deps: RecorderVideoResizerDeps = {}
): Promise<ResizedVideoStream> {
  const sourceVideoTrack = sourceStream.getVideoTracks()[0];
  if (!sourceVideoTrack) throw new Error('Cannot resize a stream without a video track');

  const sourceMetrics = readStreamVideoMetrics(sourceStream);
  if (isAtOrBelowTarget(sourceMetrics, target)) {
    return {
      stream: sourceStream,
      resized: false,
      source: sourceMetrics,
      output: sourceMetrics,
      cleanup: () => {},
    };
  }

  const documentLike = deps.document ?? (
    typeof document !== 'undefined'
      ? {
          createElement: ((tagName: 'video' | 'canvas') => document.createElement(tagName)) as DocumentLike['createElement'],
        }
      : null
  );

  if (!documentLike) throw new Error('Document is unavailable for live tab resizing');

  const video = documentLike.createElement('video') as VideoElementLike;
  prepareVideoElement(video);
  video.srcObject = sourceStream;

  const playPromise = Promise.resolve().then(() => video.play());
  await waitForVideoMetadata(video);
  await playPromise;

  const measuredSource: StreamVideoMetrics = {
    width: video.videoWidth || sourceMetrics.width,
    height: video.videoHeight || sourceMetrics.height,
    frameRate: sourceMetrics.frameRate,
  };
  if (isAtOrBelowTarget(measuredSource, target)) {
    cleanupVideoElement(video);
    return {
      stream: sourceStream,
      resized: false,
      source: measuredSource,
      output: measuredSource,
      cleanup: () => {},
    };
  }

  const canvas = documentLike.createElement('canvas') as CanvasElementLike;
  canvas.width = target.width;
  canvas.height = target.height;
  canvas.hidden = true;

  if (canvas.style) {
    canvas.style.position = 'fixed';
    canvas.style.left = '-99999px';
    canvas.style.top = '-99999px';
    canvas.style.opacity = '0';
    canvas.style.pointerEvents = 'none';
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    cleanupVideoElement(video);
    throw new Error('2D canvas context is unavailable for live tab resizing');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const drawFrame = () => {
    try {
      ctx.drawImage(video as any, 0, 0, target.width, target.height);
    } catch {}
  };

  drawFrame();

  const resizedCanvasStream = canvas.captureStream(target.frameRate);
  const resizedVideoTrack = resizedCanvasStream.getVideoTracks()[0];
  if (!resizedVideoTrack) {
    stopStream(resizedCanvasStream);
    cleanupVideoElement(video);
    throw new Error('Canvas capture did not produce a video track');
  }

  const outputStream = createCombinedStream(
    [resizedVideoTrack, ...sourceStream.getAudioTracks()],
    deps
  );

  const outputMetrics = readStreamVideoMetrics(resizedCanvasStream);
  const raf = deps.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelRaf = deps.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearScheduledTimeout = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);

  let stopped = false;
  let frameHandle: number | ReturnType<typeof setTimeout> | null = null;
  let frameMode: 'video' | 'animation' | 'timeout' | null = null;

  const cancelScheduledFrame = () => {
    if (frameHandle == null || !frameMode) return;

    if (frameMode === 'video') {
      try {
        video.cancelVideoFrameCallback?.(frameHandle as number);
      } catch {}
    } else if (frameMode === 'animation') {
      try {
        cancelRaf?.(frameHandle as number);
      } catch {}
    } else {
      clearScheduledTimeout(frameHandle as ReturnType<typeof setTimeout>);
    }

    frameHandle = null;
    frameMode = null;
  };

  const scheduleNextFrame = () => {
    if (stopped) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
      frameMode = 'video';
      frameHandle = video.requestVideoFrameCallback(() => {
        drawFrame();
        scheduleNextFrame();
      });
      return;
    }

    if (raf) {
      frameMode = 'animation';
      frameHandle = raf(() => {
        drawFrame();
        scheduleNextFrame();
      });
      return;
    }

    frameMode = 'timeout';
    frameHandle = scheduleTimeout(() => {
      drawFrame();
      scheduleNextFrame();
    }, Math.max(1, Math.round(1000 / Math.max(target.frameRate, 1))));
  };

  scheduleNextFrame();

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelScheduledFrame();
    stopStream(resizedCanvasStream);
    cleanupVideoElement(video);
    canvas.width = 0;
    canvas.height = 0;
  };

  return {
    stream: outputStream,
    resized: true,
    source: measuredSource,
    output: {
      width: outputMetrics.width ?? target.width,
      height: outputMetrics.height ?? target.height,
      frameRate: outputMetrics.frameRate ?? target.frameRate,
    },
    cleanup,
  };
}
