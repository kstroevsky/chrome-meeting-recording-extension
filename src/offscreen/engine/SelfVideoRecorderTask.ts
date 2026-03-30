/**
 * @file offscreen/engine/SelfVideoRecorderTask.ts
 *
 * Starts, writes, and seals the self-video (camera) MediaRecorder stream.
 */

import {
  getDefaultSelfVideoBitrate,
  getChunkTimesliceMs,
  getSelfVideoProfile,
  getVideoOnlyMime,
  resolveSelfVideoBitrate,
} from '../RecorderProfiles';
import { describeMediaError } from '../RecorderSupport';
import { maybeGetSelfVideoStream } from '../RecorderCapture';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/extensionSettings';
import { logPerf } from '../../shared/perf';
import {
  awaitRecorderStart,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
} from './RecorderTaskUtils';
import type { CompletedRecordingArtifact, RecorderEngineDeps } from './RecorderEngineTypes';

export type SelfVideoRecorderCallbacks = {
  onStarted: () => void;
  onStopped: (artifact: CompletedRecordingArtifact | null) => void;
  onWarning?: (message: string) => void;
};

/** Reports a warning when the browser delivers a lower camera profile than requested. */
function maybeReportSelfVideoWarning(
  settings: MediaTrackSettings | undefined,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  formatVideoMetrics: (w?: number, h?: number, fps?: number) => string,
  onWarning?: (message: string) => void
): void {
  if (!onWarning) return;
  const profile = getSelfVideoProfile(recorderSettings.selfVideo.profile);
  const sizeMismatch = settings?.width !== profile.width || settings?.height !== profile.height;
  const frameRateMismatch =
    typeof settings?.frameRate === 'number' && settings.frameRate + 0.5 < profile.frameRate;

  if (!sizeMismatch && !frameRateMismatch) return;

  onWarning(
    `Camera recording requested ${formatVideoMetrics(profile.width, profile.height, profile.frameRate)}, `
    + `but browser delivered ${formatVideoMetrics(settings?.width, settings?.height, settings?.frameRate)}. `
    + 'Extension camera quality is controlled by extension settings; shared camera use or hardware limits can reduce the delivered profile.'
  );
}

function formatVideoMetrics(width?: number, height?: number, frameRate?: number): string {
  const resolution =
    typeof width === 'number' && typeof height === 'number'
      ? `${width}x${height}`
      : 'unknown resolution';
  const fps = typeof frameRate === 'number' ? `@${Math.round(frameRate * 10) / 10}fps` : '';
  return `${resolution}${fps}`;
}

/**
 * Acquires the camera stream, applies content hints, wires a MediaRecorder
 * against it, and starts recording. Resolves when the recorder fires `onstart`.
 *
 * Returns `null` if no camera is available or the run was cancelled first.
 */
export async function startSelfVideoRecorder(
  runId: number,
  currentRunId: () => number,
  isStale: () => boolean,
  suffix: string,
  runStartedAt: number,
  recordSelfVideo: boolean,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  deps: RecorderEngineDeps,
  callbacks: SelfVideoRecorderCallbacks
): Promise<MediaRecorder | null> {
  const selfVideo = await maybeGetSelfVideoStream(recordSelfVideo, recorderSettings.selfVideo.profile, deps);

  if (!selfVideo?.getVideoTracks().length || runId !== currentRunId() || isStale()) {
    selfVideo?.getTracks().forEach((t) => t.stop());
    if (selfVideo?.getVideoTracks().length) {
      deps.log('Self video stream obtained after stop; discarding it');
    } else {
      deps.warn('Self video stream unavailable; continuing without camera recording');
    }
    return null;
  }

  const defaultVideoBitsPerSecond = getDefaultSelfVideoBitrate(recorderSettings.selfVideo.profile);
  const mime = getVideoOnlyMime();
  let started = false;
  let actualStartTimeMs = 0;
  const timesliceMs = getChunkTimesliceMs('selfVideo', recorderSettings.chunking);

  const track = selfVideo.getVideoTracks()[0];
  const settings = track?.getSettings?.();
  logPerf(deps.log, 'recorder', 'self_video_stream_acquired', {
    width: settings?.width,
    height: settings?.height,
    frameRate: settings?.frameRate,
  });
  maybeReportSelfVideoWarning(settings, recorderSettings, formatVideoMetrics, callbacks.onWarning);

  const videoBitsPerSecond = resolveSelfVideoBitrate(
    defaultVideoBitsPerSecond,
    settings,
    recorderSettings.selfVideo.profile.minAdaptiveBitsPerSecond
  );
  try {
    if (track && 'contentHint' in track) (track as any).contentHint = 'motion';
  } catch {}

  const recorder = new MediaRecorder(selfVideo, { mimeType: mime, videoBitsPerSecond });

  const filename = `google-meet-self-video-${suffix}-${Date.now()}.webm`;
  const target = await openStorageTarget(filename, mime, deps);

  const stopSelfVideoStream = () => {
    try { selfVideo.getTracks().forEach((t) => t.stop()); } catch {}
  };

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps);
      stopSelfVideoStream();
      callbacks.onStopped(artifact ? { stream: 'selfVideo', artifact } : null);
    } catch (e) {
      deps.error(`${label} finalize/save failed`, describeMediaError(e));
      stopSelfVideoStream();
      callbacks.onStopped(null);
    }
  };

  selfVideo.getVideoTracks()[0]?.addEventListener('ended', () => {
    deps.log('Self video track ended');
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
  });

  recorder.ondataavailable = makeChunkHandler(target, 'selfVideo', deps);
  recorder.onerror = (e: any) => {
    deps.error('Self video MediaRecorder error', e);
    void finalize('Self video');
  };
  recorder.onstop = () => {
    void finalize('Self video');
  };

  const { actualStartTimeMs: startMs } = await awaitRecorderStart(
    recorder,
    'selfVideo',
    runStartedAt,
    mime,
    timesliceMs,
    callbacks.onStarted,
    deps.log,
    { videoBitsPerSecond }
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}
