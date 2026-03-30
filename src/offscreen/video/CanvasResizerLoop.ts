/**
 * @file offscreen/video/CanvasResizerLoop.ts
 *
 * Manages the frame-draw loop for the canvas-based live video resizer.
 * Supports requestVideoFrameCallback, requestAnimationFrame, and setTimeout
 * fallbacks in that priority order.
 */

type FrameLoopDeps = {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

/**
 * Starts a continuous frame-draw loop and returns a `cancel` function.
 * The `drawFrame` callback is called before each frame is scheduled.
 */
export function startFrameLoop(
  video: { requestVideoFrameCallback?: (cb: VideoFrameRequestCallback) => number; cancelVideoFrameCallback?: (handle: number) => void },
  target: { frameRate: number },
  drawFrame: () => void,
  deps: FrameLoopDeps
): () => void {
  const raf = deps.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelRaf = deps.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearScheduledTimeout = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);

  let stopped = false;
  let frameHandle: number | ReturnType<typeof setTimeout> | null = null;
  type FrameMode = 'video' | 'animation' | 'timeout';
  let frameMode: FrameMode | null = null;

  const cancelScheduledFrame = () => {
    if (frameHandle == null || !frameMode) return;
    if (frameMode === 'video') {
      try { video.cancelVideoFrameCallback?.(frameHandle as number); } catch {}
    } else if (frameMode === 'animation') {
      try { cancelRaf?.(frameHandle as number); } catch {}
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

  return () => {
    if (stopped) return;
    stopped = true;
    cancelScheduledFrame();
  };
}
