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
import { createE2EMockTabStream } from './RecorderCaptureE2EMock';
import {
  formatSelfVideoProfile,
  getSelfVideoConstraintRequests,
  matchesSelfVideoProfile,
} from './RecorderProfiles';
import { debugPerf, nowMs, roundMs } from '../shared/perf';

export type RecorderCaptureDeps = {
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
