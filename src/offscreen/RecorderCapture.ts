/**
 * @file offscreen/RecorderCapture.ts
 *
 * Media acquisition helpers for tab, microphone, and self-video capture.
 */

import { withTimeout } from '../shared/async';
import type { MicMode } from '../shared/recording';
import {
  getMicrophoneCaptureSettings,
  getTabCaptureSettings,
} from '../shared/extensionSettings';
import { TIMEOUTS } from '../shared/timeouts';
import { queryActiveTab } from '../platform/chrome/tabs';
import { describeMediaError } from './RecorderSupport';
import {
  formatSelfVideoProfile,
  getSelfVideoConstraints,
  getSelfVideoProfile,
  matchesSelfVideoProfile,
} from './RecorderProfiles';

type RecorderCaptureDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

type SelfVideoDiagnostics = {
  ok: boolean;
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

function readTrackCapabilities(track?: MediaStreamTrack): MediaTrackCapabilities | undefined {
  try {
    return typeof track?.getCapabilities === 'function'
      ? track.getCapabilities()
      : undefined;
  } catch {
    return undefined;
  }
}

function buildSelfVideoDiagnostics(track?: MediaStreamTrack): {
  diagnostics: SelfVideoDiagnostics;
  settings: MediaTrackSettings | undefined;
} {
  const settings = track?.getSettings?.();
  const capabilities = readTrackCapabilities(track);
  const profile = getSelfVideoProfile();

  return {
    diagnostics: {
      ok: !!track,
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

function makeTabCaptureConstraints(
  streamId: string,
  source: 'tab' | 'desktop'
): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any;
  const tab = getTabCaptureSettings();
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }],
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth: tab.maxWidth,
        maxHeight: tab.maxHeight,
        maxFrameRate: tab.maxFrameRate,
      },
    } as any,
  };
}

export async function captureTabStreamFromId(
  streamId: string,
  deps: RecorderCaptureDeps
): Promise<MediaStream> {
  deps.log(`Attempting getUserMedia with streamId ${streamId} source=tab`);
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'tab')),
      TIMEOUTS.GUM_MS,
      'tab getUserMedia'
    );
  } catch (error: any) {
    deps.warn('[gUM] failed for chromeMediaSource=tab:', error?.name || error, error?.message || error);
  }

  deps.log(`Attempting getUserMedia with streamId ${streamId} source=desktop`);
  return await withTimeout(
    navigator.mediaDevices.getUserMedia(makeTabCaptureConstraints(streamId, 'desktop')),
    TIMEOUTS.GUM_MS,
    'desktop getUserMedia'
  );
}

export async function maybeGetMicStream(
  micMode: MicMode,
  deps: RecorderCaptureDeps
): Promise<MediaStream | null> {
  if (micMode === 'off') return null;
  const microphone = getMicrophoneCaptureSettings();

  try {
    const mic = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: microphone,
      }),
      TIMEOUTS.GUM_MS,
      'mic getUserMedia'
    );

    const track = mic.getAudioTracks()[0];
    deps.log('mic stream acquired:', !!track, 'muted:', track?.muted, 'enabled:', track?.enabled);
    return mic;
  } catch (error) {
    const label = micMode === 'mixed'
      ? 'mic getUserMedia failed (mixed mode requires microphone)'
      : 'mic getUserMedia failed (continuing without separate mic file)';
    deps.warn(label, describeMediaError(error));
    return null;
  }
}

export async function maybeGetSelfVideoStream(
  enabled: boolean,
  deps: RecorderCaptureDeps
): Promise<MediaStream | null> {
  if (!enabled) return null;
  const constraints = getSelfVideoConstraints();

  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: constraints,
        audio: false,
      }),
      TIMEOUTS.GUM_MS,
      'self video getUserMedia'
    );
    const track = stream.getVideoTracks()[0];
    const { diagnostics, settings } = buildSelfVideoDiagnostics(track);

    deps.log('self video stream acquired:', diagnostics);

    if (!matchesSelfVideoProfile(settings)) {
      deps.warn(
        `self video preferred ${formatSelfVideoProfile()} but browser delivered ${settings?.width ?? 'unknown'}x${settings?.height ?? 'unknown'}`
      );
    }
    return stream;
  } catch (error) {
    deps.warn(
      'self video getUserMedia failed (continuing without self video):',
      describeMediaError(error)
    );
    return null;
  }
}

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
