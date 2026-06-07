/**
 * @file offscreen/RecorderCapture.ts
 *
 * Media acquisition helpers for tab, microphone, and self-video capture.
 */

import { withTimeout } from '../shared/async';
import { isE2EMockCaptureBuild } from '../shared/build';
import type { MicMode } from '../shared/recording';
import { EXTENSION_DEFAULTS } from '../shared/recordingConstants';
import {
  getMicrophoneCaptureSettings,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  type MicrophoneCaptureSettings,
  type SelfVideoProfileSettings,
  type TabCaptureSettings,
} from '../shared/settings';
import { TIMEOUTS } from '../shared/timeouts';
import { describeMediaError } from './RecorderSupport';
import {
  formatSelfVideoProfile,
  getSelfVideoConstraintRequests,
  matchesSelfVideoProfile,
} from './RecorderProfiles';
import { debugPerf, nowMs, roundMs } from '../shared/perf';

type RecorderCaptureDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

type SelfVideoDiagnostics = {
  ok: boolean;
  requestStrategy: string;
  requestedWidth: number;
  requestedHeight: number;
  requestedFrameRate: number;
  width: number | undefined;
  height: number | undefined;
  frameRate: number | undefined;
  deviceId: string | undefined;
  capabilityWidth: MediaTrackCapabilities['width'] | undefined;
  capabilityHeight: MediaTrackCapabilities['height'] | undefined;
  capabilityFrameRate: MediaTrackCapabilities['frameRate'] | undefined;
  muted: boolean | undefined;
  enabled: boolean | undefined;
};

/** Reads track capabilities when supported without crashing older browser implementations. */
function readTrackCapabilities(track?: MediaStreamTrack): MediaTrackCapabilities | undefined {
  try {
    return typeof track?.getCapabilities === 'function'
      ? track.getCapabilities()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Builds structured diagnostics for the requested and delivered self-video track profile. */
function buildSelfVideoDiagnostics(
  profile: Readonly<SelfVideoProfileSettings>,
  track: MediaStreamTrack | undefined,
  requestStrategy: string
): {
  diagnostics: SelfVideoDiagnostics;
  settings: MediaTrackSettings | undefined;
} {
  const settings = track?.getSettings?.();
  const capabilities = readTrackCapabilities(track);

  return {
    diagnostics: {
      ok: !!track,
      requestStrategy,
      requestedWidth: profile.width,
      requestedHeight: profile.height,
      requestedFrameRate: profile.frameRate,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate,
      deviceId: settings?.deviceId,
      capabilityWidth: capabilities?.width,
      capabilityHeight: capabilities?.height,
      capabilityFrameRate: capabilities?.frameRate,
      muted: track?.muted,
      enabled: track?.enabled,
    },
    settings,
  };
}

/** Builds Chrome tab-capture constraints using a stable acquisition ceiling. */
function makeTabCaptureConstraints(
  streamId: string,
  source: 'tab' | 'desktop',
  tabOutput: Readonly<TabCaptureSettings>
): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any;
  const maxFrameRate = Math.min(
    tabOutput.maxFrameRate,
    EXTENSION_DEFAULTS.capture.tab.maxFrameRate
  );
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }],
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth: tabOutput.maxWidth,
        maxHeight: tabOutput.maxHeight,
        maxFrameRate,
      },
    } as any,
  };
}

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

function createE2EMockTabStream(
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

/** Acquires the tab stream from the background-provided stream id with desktop fallback. */
export async function captureTabStreamFromId(
  streamId: string,
  tabOutputOrDeps: Readonly<TabCaptureSettings> | RecorderCaptureDeps,
  deps?: RecorderCaptureDeps
): Promise<MediaStream> {
  const tabOutput = deps ? tabOutputOrDeps as Readonly<TabCaptureSettings> : getTabOutputSettings();
  const captureDeps = (deps ?? tabOutputOrDeps) as RecorderCaptureDeps;

  const mockCaptureEnabled = typeof __E2E_MOCK_CAPTURE_BUILD__ !== 'undefined'
    ? __E2E_MOCK_CAPTURE_BUILD__
    : isE2EMockCaptureBuild();
  if (mockCaptureEnabled && streamId.startsWith('__E2E_MOCK_TAB_CAPTURE__')) {
    return createE2EMockTabStream(tabOutput, captureDeps);
  }

  const captureStartedAt = nowMs();
  let tabCaptureError = 'unknown';
  captureDeps.log(`Attempting getUserMedia with streamId ${streamId} source=tab`);
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'tab', tabOutput)),
      TIMEOUTS.GUM_MS,
      'tab getUserMedia'
    );
    const settings = stream.getVideoTracks()[0]?.getSettings?.();
    debugPerf(captureDeps.log, 'capture', 'stream_acquired', {
      stream: 'tab',
      durationMs: roundMs(nowMs() - captureStartedAt),
      requestedWidth: tabOutput.maxWidth,
      requestedHeight: tabOutput.maxHeight,
      requestedFrameRate: tabOutput.maxFrameRate,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate,
      source: 'tab',
    });
    return stream;
  } catch (error: any) {
    tabCaptureError = describeMediaError(error);
    captureDeps.warn('[gUM] failed for chromeMediaSource=tab:', tabCaptureError);
  }

  captureDeps.log(`Attempting getUserMedia with streamId ${streamId} source=desktop`);
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'desktop', tabOutput)),
      TIMEOUTS.GUM_MS,
      'desktop getUserMedia'
    );
    const settings = stream.getVideoTracks()[0]?.getSettings?.();
    debugPerf(captureDeps.log, 'capture', 'stream_acquired', {
      stream: 'tab',
      durationMs: roundMs(nowMs() - captureStartedAt),
      requestedWidth: tabOutput.maxWidth,
      requestedHeight: tabOutput.maxHeight,
      requestedFrameRate: tabOutput.maxFrameRate,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate,
      source: 'desktop',
    });
    return stream;
  } catch (error) {
    const desktopCaptureError = describeMediaError(error);
    debugPerf(captureDeps.log, 'capture', 'stream_failed', {
      stream: 'tab',
      durationMs: roundMs(nowMs() - captureStartedAt),
    });
    throw new Error(
      `Tab capture acquisition failed: tab=${tabCaptureError}; desktop=${desktopCaptureError}`
    );
  }
}

/** Requests a microphone stream when the active run configuration needs one. */
export async function maybeGetMicStream(
  micMode: MicMode,
  microphoneOrDeps: Readonly<MicrophoneCaptureSettings> | RecorderCaptureDeps,
  deps?: RecorderCaptureDeps
): Promise<MediaStream | null> {
  if (micMode === 'off') return null;
  const microphone = deps ? microphoneOrDeps as Readonly<MicrophoneCaptureSettings> : getMicrophoneCaptureSettings();
  const captureDeps = (deps ?? microphoneOrDeps) as RecorderCaptureDeps;
  const captureStartedAt = nowMs();

  try {
    const mic = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: microphone,
      }),
      TIMEOUTS.GUM_MS,
      'mic getUserMedia'
    );

    const track = mic.getAudioTracks()[0];
    const settings = track?.getSettings?.();
    debugPerf(captureDeps.log, 'capture', 'stream_acquired', {
      stream: 'mic',
      durationMs: roundMs(nowMs() - captureStartedAt),
      sampleRate: settings?.sampleRate,
      channelCount: settings?.channelCount,
      // Requested DSP constraints (from settings) vs. what the device applied,
      // so the echo/noise/AGC toggles are observable in the perf snapshot.
      requestedEchoCancellation: microphone.echoCancellation,
      requestedNoiseSuppression: microphone.noiseSuppression,
      requestedAutoGainControl: microphone.autoGainControl,
      echoCancellation: settings?.echoCancellation,
      noiseSuppression: settings?.noiseSuppression,
      autoGainControl: settings?.autoGainControl,
    });
    captureDeps.log('mic stream acquired:', !!track, 'muted:', track?.muted, 'enabled:', track?.enabled);
    return mic;
  } catch (error) {
    debugPerf(captureDeps.log, 'capture', 'stream_failed', {
      stream: 'mic',
      durationMs: roundMs(nowMs() - captureStartedAt),
    });
    const label = micMode === 'mixed'
      ? 'mic getUserMedia failed (mixed mode requires microphone)'
      : 'mic getUserMedia failed (continuing without separate mic file)';
    captureDeps.warn(label, describeMediaError(error));
    return null;
  }
}

/** Requests the user's camera stream and logs how closely it matched the preset. */
export async function maybeGetSelfVideoStream(
  enabled: boolean,
  profileOrDeps: Readonly<SelfVideoProfileSettings> | RecorderCaptureDeps,
  deps?: RecorderCaptureDeps
): Promise<MediaStream | null> {
  if (!enabled) return null;
  const profile = deps ? profileOrDeps as Readonly<SelfVideoProfileSettings> : getSelfVideoProfileSettings();
  const captureDeps = (deps ?? profileOrDeps) as RecorderCaptureDeps;
  const requests = getSelfVideoConstraintRequests(profile);
  const captureStartedAt = nowMs();

  for (const request of requests) {
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: request.constraints,
          audio: false,
        }),
        TIMEOUTS.GUM_MS,
        'self video getUserMedia'
      );
      const track = stream.getVideoTracks()[0];
      const { diagnostics, settings } = buildSelfVideoDiagnostics(profile, track, request.label);

      debugPerf(captureDeps.log, 'capture', 'stream_acquired', {
        stream: 'self-video',
        durationMs: roundMs(nowMs() - captureStartedAt),
        requestedWidth: profile.width,
        requestedHeight: profile.height,
        requestedFrameRate: profile.frameRate,
        width: settings?.width,
        height: settings?.height,
        frameRate: settings?.frameRate,
        requestStrategy: request.label,
      });
      captureDeps.log('self video stream acquired:', diagnostics);

      if (!matchesSelfVideoProfile(settings, profile)) {
        captureDeps.warn(
          `self video preferred ${formatSelfVideoProfile(profile)} but browser delivered ${settings?.width ?? 'unknown'}x${settings?.height ?? 'unknown'}`
        );
      }
      return stream;
    } catch (error) {
      const formattedError = describeMediaError(error);
      if (request !== requests[requests.length - 1]) {
        captureDeps.log(
          'self video getUserMedia attempt failed; retrying with fallback',
          {
            requestStrategy: request.label,
            error: formattedError,
          }
        );
        continue;
      }

      captureDeps.warn(
        'self video getUserMedia failed (continuing without self video):',
        formattedError
      );
      debugPerf(captureDeps.log, 'capture', 'stream_failed', {
        stream: 'self-video',
        durationMs: roundMs(nowMs() - captureStartedAt),
        requestedWidth: profile.width,
        requestedHeight: profile.height,
        requestedFrameRate: profile.frameRate,
      });
      return null;
    }
  }

  return null;
}
