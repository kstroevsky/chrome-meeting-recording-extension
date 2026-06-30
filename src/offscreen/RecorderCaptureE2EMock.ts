/**
 * @file offscreen/RecorderCaptureE2EMock.ts
 *
 * Synthetic tab-capture stream for end-to-end tests. Reached only from
 * {@link captureTabStreamFromId} when the build is an e2e-mock build
 * (`__E2E_MOCK_CAPTURE_BUILD__` / `isE2EMockCaptureBuild()`) and the stream id is the
 * sentinel `__E2E_MOCK_TAB_CAPTURE__`. Kept out of `RecorderCapture.ts` so the
 * production capture path carries no test scaffolding.
 *
 * The stream is a `<canvas>` animation (a moving frame counter + a periodic
 * black/white marker) plus a matching audio tone, so an e2e assertion can verify the
 * recorded artifact actually contains changing video and synchronized audio.
 */

import { debugPerf, nowMs, roundMs } from '../shared/perf';
import type { TabCaptureSettings } from '../shared/settings';
import type { RecorderCaptureDeps } from './RecorderCapture';
import { describeMediaError } from './RecorderSupport';

/** Wraps `track.stop()` so the synthetic stream's timers/audio context are torn down once. */
function patchTrackStop(track: MediaStreamTrack | undefined, cleanup: () => void): void {
  if (!track) return;
  const originalStop = track.stop.bind(track);
  let cleaned = false;
  track.stop = () => {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
    originalStop();
  };
}

/** Builds a synthetic animated tab-capture stream (video + audio) for e2e-mock builds. */
export function createE2EMockTabStream(
  tabOutput: Readonly<TabCaptureSettings>,
  deps: RecorderCaptureDeps
): MediaStream {
  const captureStartedAt = nowMs();
  const canvas = document.createElement('canvas');
  canvas.width = tabOutput.maxWidth;
  canvas.height = tabOutput.maxHeight;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  const captureFrameRate = Math.max(1, Math.min(tabOutput.maxFrameRate, 30));
  let markerGain: GainNode | null = null;
  let markerOscillator: OscillatorNode | null = null;

  const draw = () => {
    if (!ctx) return;
    const hue = (frame * 6) % 360;
    ctx.fillStyle = `hsl(${hue}, 60%, 24%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8fafc';
    ctx.font = '40px sans-serif';
    ctx.fillText('E2E mock tab capture', 32, 72);
    ctx.font = '24px sans-serif';
    ctx.fillText(`Frame ${frame}`, 32, 116);
    const markerActive = frame % captureFrameRate < Math.max(1, Math.round(captureFrameRate / 10));
    ctx.fillStyle = markerActive ? '#ffffff' : '#000000';
    ctx.fillRect(canvas.width - 96, 32, 64, 64);
    if (markerGain && markerOscillator) {
      markerGain.gain.value = markerActive ? 0.08 : 0;
      markerOscillator.frequency.value = markerActive ? 880 : 440;
    }
    frame += 1;
  };

  draw();
  const timer = window.setInterval(draw, 1000 / captureFrameRate);
  const stream = canvas.captureStream(captureFrameRate);
  const cleanupCallbacks: Array<() => void> = [() => clearInterval(timer)];

  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextCtor) {
      const audio = new AudioContextCtor();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = 0;
      oscillator.frequency.value = 440;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      markerGain = gain;
      markerOscillator = oscillator;
      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);
      cleanupCallbacks.push(() => {
        try { oscillator.stop(); } catch {}
        void audio.close().catch(() => {});
      });
    }
  } catch (error) {
    deps.warn('E2E mock tab audio setup failed; continuing with video-only stream', describeMediaError(error));
  }

  const cleanup = () => {
    while (cleanupCallbacks.length) cleanupCallbacks.shift()?.();
  };
  stream.getTracks().forEach((track) => patchTrackStop(track, cleanup));
  const videoSettings = stream.getVideoTracks()[0]?.getSettings?.();
  debugPerf(deps.log, 'capture', 'stream_acquired', {
    stream: 'tab',
    durationMs: roundMs(nowMs() - captureStartedAt),
    requestedWidth: tabOutput.maxWidth,
    requestedHeight: tabOutput.maxHeight,
    requestedFrameRate: tabOutput.maxFrameRate,
    width: videoSettings?.width ?? tabOutput.maxWidth,
    height: videoSettings?.height ?? tabOutput.maxHeight,
    frameRate: videoSettings?.frameRate ?? Math.min(tabOutput.maxFrameRate, 30),
    synthetic: true,
  });
  deps.log('Using E2E mock tab capture stream');
  return stream;
}
