/**
 * @file offscreen/RecorderCapture.ts
 *
 * Media acquisition helpers for tab, microphone, and self-video capture.
 */

import { withTimeout } from '../shared/async';
import type { MicMode, RecordingRunConfig } from '../shared/recording';
import { TIMEOUTS } from '../shared/timeouts';
import { queryActiveTab } from '../platform/chrome/tabs';
import { describeMediaError } from './RecorderSupport';

type RecorderCaptureDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

type SelfVideoProfile = {
  constraints: MediaTrackConstraints;
  defaultVideoBitsPerSecond: number;
};

function makeTabCaptureConstraints(
  streamId: string,
  source: 'tab' | 'desktop'
): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any;
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }],
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    } as any,
  };
}

function getSelfVideoProfile(quality: RecordingRunConfig['selfVideoQuality']): SelfVideoProfile {
  if (quality === 'high') {
    return {
      constraints: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
      defaultVideoBitsPerSecond: 2_500_000,
    };
  }

  return {
    constraints: {
      width: { ideal: 960, max: 960 },
      height: { ideal: 540, max: 540 },
      frameRate: { ideal: 24, max: 24 },
    },
    defaultVideoBitsPerSecond: 1_200_000,
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

  try {
    const mic = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
  quality: RecordingRunConfig['selfVideoQuality'],
  deps: RecorderCaptureDeps
): Promise<MediaStream | null> {
  if (!enabled) return null;
  const profile = getSelfVideoProfile(quality);

  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: profile.constraints,
        audio: false,
      }),
      TIMEOUTS.GUM_MS,
      'self video getUserMedia'
    );

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    deps.log('self video stream acquired:', {
      ok: !!track,
      quality,
      width: settings?.width,
      height: settings?.height,
      frameRate: settings?.frameRate,
      deviceId: settings?.deviceId,
      muted: track?.muted,
      enabled: track?.enabled,
    });
    return stream;
  } catch (error) {
    deps.warn(
      'self video getUserMedia failed (continuing without self video):',
      describeMediaError(error)
    );
    return null;
  }
}

export function getDefaultSelfVideoBitrate(
  quality: RecordingRunConfig['selfVideoQuality']
): number {
  return getSelfVideoProfile(quality).defaultVideoBitsPerSecond;
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
