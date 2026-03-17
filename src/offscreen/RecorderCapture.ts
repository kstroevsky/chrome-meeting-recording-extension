/**
 * @file offscreen/RecorderCapture.ts
 *
 * Media acquisition helpers for tab, microphone, and self-video capture.
 */

import { withTimeout } from '../shared/async';
import type { MicMode } from '../shared/recording';
import { EXTENSION_DEFAULTS } from '../shared/recordingConstants';
import {
  getMicrophoneCaptureSettings,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  type ExtensionSettings,
  MicrophoneCaptureSettings,
  SelfVideoProfileSettings,
  TabCaptureSettings,
} from '../shared/extensionSettings';
import { TIMEOUTS } from '../shared/timeouts';
import { queryActiveTab } from '../platform/chrome/tabs';
import { describeMediaError } from './RecorderSupport';
import {
  formatSelfVideoProfile,
  getSelfVideoConstraintRequests,
  matchesSelfVideoProfile,
} from './RecorderProfiles';

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
        maxWidth: EXTENSION_DEFAULTS.capture.tab.maxWidth,
        maxHeight: EXTENSION_DEFAULTS.capture.tab.maxHeight,
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

  captureDeps.log(`Attempting getUserMedia with streamId ${streamId} source=tab`);
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'tab', tabOutput)),
      TIMEOUTS.GUM_MS,
      'tab getUserMedia'
    );
  } catch (error: any) {
    captureDeps.warn('[gUM] failed for chromeMediaSource=tab:', error?.name || error, error?.message || error);
  }

  captureDeps.log(`Attempting getUserMedia with streamId ${streamId} source=desktop`);
  return await withTimeout(
    navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'desktop', tabOutput)),
    TIMEOUTS.GUM_MS,
    'desktop getUserMedia'
  );
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

  try {
    const mic = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: microphone,
      }),
      TIMEOUTS.GUM_MS,
      'mic getUserMedia'
    );

    const track = mic.getAudioTracks()[0];
    captureDeps.log('mic stream acquired:', !!track, 'muted:', track?.muted, 'enabled:', track?.enabled);
    return mic;
  } catch (error) {
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
      return null;
    }
  }

  return null;
}

/** Derives a stable filename suffix from the active tab URL when possible. */
export async function inferActiveTabSuffix(): Promise<string> {
  const url = (await queryActiveTab())?.url || null;

  try {
    if (!url) return 'google-meet';
    const parsed = new URL(url);
    return parsed.pathname.split('/').pop() || 'google-meet';
  } catch {
    return 'google-meet';
  }
}
