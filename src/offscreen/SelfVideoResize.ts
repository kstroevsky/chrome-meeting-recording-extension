/**
 * @file offscreen/SelfVideoResize.ts
 *
 * Forces the encoded self-video (camera) resolution to match the user's
 * selected preset, even when another consumer — most importantly the live
 * Google Meet call — already holds the same physical camera open at a higher
 * resolution.
 *
 * Why this exists: when a camera device is shared, Chrome reports the *requested*
 * downscaled size through `MediaStreamTrack.getSettings()` and the
 * `HTMLVideoElement` display size, but the frames actually delivered to a
 * `MediaRecorder` are the shared source's native ("coded") size. The VP8 encoder
 * then records at the coded size, so `selfVideoResolutionPreset` silently has no
 * effect on the saved file (e.g. a 640x360 preset records 1280x720 while Meet
 * holds the camera at 720p). `crop-and-scale` only affects the display rect, not
 * the encoded buffer.
 *
 * The fix: read one frame's `codedWidth`/`codedHeight` and, when it differs from
 * the target, route the camera through
 * `MediaStreamTrackProcessor -> OffscreenCanvas -> MediaStreamTrackGenerator`,
 * downscaling each frame to the target. `drawImage(VideoFrame, …)` honors the
 * frame's display/visible-rect, so aspect ratio (the camera's own crop-and-scale)
 * is preserved. When no resize is needed — or the platform lacks insertable
 * streams — the original stream is returned unchanged, so non-contended captures
 * keep zero overhead.
 */

import { logPerf } from '../shared/perf';

export type EnforcedSelfVideoStream = {
  /** The stream to hand to MediaRecorder (a resized track when necessary). */
  stream: MediaStream;
  /** Stops the resize pump and output track. No-op when no resize was inserted. Idempotent. */
  stop: () => void;
  /** True when a resize transform was inserted. */
  resized: boolean;
  /**
   * Hides/shows the encoded camera (black frames) without tearing the track down.
   * Blacks out at the layer that is actually defined for the active path: `enabled
   * = false` on the camera track when recording it directly, or a black-frame fill
   * inside the resize pump when rerouted through insertable streams (where the
   * effect of `enabled` is unspecified — mediacapture-transform defines no
   * disabled-track behavior for MediaStreamTrackProcessor).
   */
  setMuted: (muted: boolean) => void;
  /**
   * The dimensions MediaRecorder will actually encode, when known: the target
   * when a resize was inserted, or the probed native coded size when recording
   * the camera directly. Used to size the bitrate, because `getSettings()`
   * under-reports the encoded size under camera contention. Undefined when the
   * coded size couldn't be probed (e.g. no insertable streams).
   */
  encodedSize?: { width: number; height: number };
};

type Size = { width: number; height: number };

/** Max time to wait for the camera's first frame during coded-size detection. */
const DETECT_TIMEOUT_MS = 2_000;

/** True when this context exposes the insertable-streams APIs needed to resize. */
function hasInsertableStreams(): boolean {
  const g = globalThis as any;
  return (
    typeof g.MediaStreamTrackProcessor === 'function' &&
    typeof g.MediaStreamTrackGenerator === 'function' &&
    typeof g.OffscreenCanvas === 'function' &&
    typeof g.VideoFrame === 'function'
  );
}

/**
 * Reads one frame from a short-lived clone of the track to learn the true coded
 * buffer size (the size the encoder would use). The clone is always stopped, so
 * the original capture track is untouched and free to be recorded directly.
 */
async function detectCodedSize(track: MediaStreamTrack): Promise<Size | null> {
  const g = globalThis as any;
  const probe = track.clone();
  let reader: any = null;
  try {
    const processor = new g.MediaStreamTrackProcessor({ track: probe });
    reader = processor.readable.getReader();
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), DETECT_TIMEOUT_MS)
    );
    const first = await Promise.race([reader.read(), timeout]);
    if (!first || first.done || !first.value) return null;
    const frame = first.value;
    const size = { width: frame.codedWidth as number, height: frame.codedHeight as number };
    frame.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  } finally {
    if (reader) try { await reader.cancel(); } catch {}
    try { probe.stop(); } catch {}
  }
}

/** Builds an output track that downscales every camera frame to width x height. */
function buildResizedTrack(
  track: MediaStreamTrack,
  width: number,
  height: number
): { track: MediaStreamTrack; stop: () => void; setMuted: (muted: boolean) => void } {
  const g = globalThis as any;
  const processor = new g.MediaStreamTrackProcessor({ track });
  const generator = new g.MediaStreamTrackGenerator({ kind: 'video' });
  try { (generator as any).contentHint = 'motion'; } catch {}
  const canvas = new g.OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();

  let stopped = false;
  let muted = false;

  const pump = async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        if (stopped) { frame.close(); break; }
        try {
          if (muted) {
            // Hidden: write a black frame at the source cadence instead of the
            // camera image. Blacking out here — where we own the encoded frame —
            // is deterministic, unlike relying on `enabled` propagating through
            // MediaStreamTrackProcessor (undefined per mediacapture-transform).
            context.fillStyle = '#000';
            context.fillRect(0, 0, width, height);
          } else {
            // drawImage uses the VideoFrame's display rect, preserving the
            // camera's intended crop-and-scale while forcing the encoded size.
            context.drawImage(frame, 0, 0, width, height);
          }
          const resized = new g.VideoFrame(canvas, {
            timestamp: frame.timestamp,
            ...(frame.duration == null ? {} : { duration: frame.duration }),
          });
          frame.close();
          await writer.write(resized);
          resized.close();
        } catch {
          try { frame.close(); } catch {}
          if (stopped) break;
        }
      }
    } catch {
      /* source track ended or pipeline torn down */
    } finally {
      try { await writer.close(); } catch {}
    }
  };
  void pump();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { reader.cancel(); } catch {}
    try { (generator as any).stop?.(); } catch {}
  };

  return { track: generator, stop, setMuted: (next: boolean) => { muted = next; } };
}

/**
 * Returns a stream whose single video track encodes at exactly `target`,
 * inserting a resize transform only when the camera's true coded frame size
 * differs from the target. Falls back to the original stream unchanged when the
 * platform lacks insertable streams, detection fails, or no resize is needed.
 */
export async function enforceSelfVideoResolution(
  source: MediaStream,
  target: Size,
  log: (...a: any[]) => void,
  options: { auto?: boolean } = {}
): Promise<EnforcedSelfVideoStream> {
  const noop: EnforcedSelfVideoStream = {
    stream: source,
    stop: () => {},
    resized: false,
    // No resize transform: MediaRecorder records the camera track directly, so
    // `enabled = false` → black frames is the well-defined MediaStreamTrack
    // contract here (unlike the resized insertable-streams path).
    setMuted: (muted: boolean) => {
      for (const t of source.getVideoTracks()) { try { t.enabled = !muted; } catch {} }
    },
  };
  const track = source.getVideoTracks()[0];
  if (!track) return noop;

  // "Prefer auto resolution": record whatever Chrome/Meet already selected — skip
  // the resize re-rasterization (and its per-frame cost) entirely. We still probe
  // the true coded size once (one frame, cheap) so the bitrate can match what is
  // actually encoded; getSettings() under-reports it under camera contention.
  if (options.auto) {
    log('self-video: preferring auto resolution; skipping resize enforcement');
    const codedAuto = hasInsertableStreams() ? await detectCodedSize(track) : null;
    return { ...noop, encodedSize: codedAuto ?? undefined };
  }

  if (target.width <= 0 || target.height <= 0 || !hasInsertableStreams()) {
    return noop;
  }

  const coded = await detectCodedSize(track);
  if (!coded) return noop;

  if (coded.width === target.width && coded.height === target.height) {
    logPerf(log, 'recorder', 'self_video_resolution_enforced', {
      stream: 'self-video',
      targetWidth: target.width,
      targetHeight: target.height,
      codedWidth: coded.width,
      codedHeight: coded.height,
      resized: false,
    });
    // Recording the source directly at the coded size — that IS the encoded size.
    return { ...noop, encodedSize: coded };
  }

  const { track: resizedTrack, stop, setMuted } = buildResizedTrack(track, target.width, target.height);
  logPerf(log, 'recorder', 'self_video_resolution_enforced', {
    stream: 'self-video',
    targetWidth: target.width,
    targetHeight: target.height,
    codedWidth: coded.width,
    codedHeight: coded.height,
    resized: true,
  });
  // The resize forces the encoded buffer to the target size.
  return { stream: new MediaStream([resizedTrack]), stop, resized: true, setMuted, encodedSize: { width: target.width, height: target.height } };
}
