/**
 * @file offscreen/engine/SelfVideoRecorderTask.ts
 *
 * Starts, writes, and seals the self-video (camera) MediaRecorder stream.
 *
 * Initialization is split into two phases:
 *  1. acquireSelfVideoStream  — getUserMedia, staleness check, perf/warning reporting
 *  2. startWiredSelfVideoRecorder — recorder creation, event wiring, await start
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
  buildRecordingFilename,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
} from './RecorderTaskUtils';
import type { CompletedRecordingArtifact, RecorderEngineDeps } from './RecorderEngineTypes';

export type SelfVideoRecorderCallbacks = {
  onStarted: () => void;
  onStopped: (artifact: CompletedRecordingArtifact | null) => void;
  onWarning?: (message: string) => void;
  /** Called once the camera stream is acquired; receives an idempotent stop-stream function. */
  onStreamAcquired?: (stopStream: () => void) => void;
};

function formatVideoMetrics(width?: number, height?: number, frameRate?: number): string {
  const resolution =
    typeof width === 'number' && typeof height === 'number'
      ? `${width}x${height}`
      : 'unknown resolution';
  const fps = typeof frameRate === 'number' ? `@${Math.round(frameRate * 10) / 10}fps` : '';
  return `${resolution}${fps}`;
}

/** Reports a warning when the browser delivers a lower camera profile than requested. */
function maybeReportSelfVideoWarning(
  settings: MediaTrackSettings | undefined,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
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

/**
 * Phase 1 — Acquires the camera stream and validates it is still needed.
 *
 * Returns the stream if recording should proceed, or `null` if the stream was
 * unavailable, the run was already cancelled, or the engine transitioned away.
 * Logs perf data and fires onWarning for profile mismatches.
 */
async function acquireSelfVideoStream(
  runId: number,
  currentRunId: () => number,
  isStale: () => boolean,
  recordSelfVideo: boolean,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  deps: RecorderEngineDeps,
  onWarning?: (message: string) => void
): Promise<MediaStream | null> {
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

  const track = selfVideo.getVideoTracks()[0];
  const settings = track?.getSettings?.();
  logPerf(deps.log, 'recorder', 'self_video_stream_acquired', {
    width: settings?.width,
    height: settings?.height,
    frameRate: settings?.frameRate,
  });
  maybeReportSelfVideoWarning(settings, recorderSettings, onWarning);

  try {
    if (track && 'contentHint' in track) (track as any).contentHint = 'motion';
  } catch {}

  return selfVideo;
}

/**
 * Phase 2 — Creates the MediaRecorder against an already-acquired stream,
 * wires all event handlers, and awaits the recorder's `onstart` event.
 *
 * The stream's tracks are released via an idempotent closure that is passed to
 * `callbacks.onStreamAcquired`, allowing the engine to stop the camera eagerly
 * when the user clicks stop before the recorder's `onstop` fires.
 */
async function startWiredSelfVideoRecorder(
  selfVideo: MediaStream,
  suffix: string,
  runStartedAt: number,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  deps: RecorderEngineDeps,
  callbacks: SelfVideoRecorderCallbacks
): Promise<MediaRecorder> {
  const track = selfVideo.getVideoTracks()[0];
  const settings = track?.getSettings?.();
  const mime = getVideoOnlyMime();
  const timesliceMs = getChunkTimesliceMs('self-video', recorderSettings.chunking);
  const videoBitsPerSecond = resolveSelfVideoBitrate(
    getDefaultSelfVideoBitrate(recorderSettings.selfVideo.profile),
    settings,
    recorderSettings.selfVideo.profile.minAdaptiveBitsPerSecond
  );

  const recorder = new MediaRecorder(selfVideo, { mimeType: mime, videoBitsPerSecond });
  const target = await openStorageTarget(buildRecordingFilename(suffix, 'self-video'), mime, deps);

  let selfVideoStreamStopped = false;
  const stopSelfVideoStream = () => {
    if (selfVideoStreamStopped) return;
    selfVideoStreamStopped = true;
    try { selfVideo.getTracks().forEach((t) => t.stop()); } catch {}
  };
  callbacks.onStreamAcquired?.(stopSelfVideoStream);

  let started = false;
  let actualStartTimeMs = 0;

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps);
      stopSelfVideoStream();
      callbacks.onStopped(artifact ? { stream: 'self-video', artifact } : null);
    } catch (e) {
      deps.error(`${label} finalize/save failed`, describeMediaError(e));
      stopSelfVideoStream();
      callbacks.onStopped(null);
    }
  };

  selfVideo.getVideoTracks()[0]?.addEventListener('ended', () => {
    deps.log('Self video track ended');
    if (recorder.state !== 'inactive') try { recorder.stop(); } catch {}
  });
  recorder.ondataavailable = makeChunkHandler(target, 'self-video', deps);
  recorder.onerror = (e: any) => { deps.error('Self video MediaRecorder error', e); void finalize('Self video'); };
  recorder.onstop = () => { void finalize('Self video'); };

  const { actualStartTimeMs: startMs } = await awaitRecorderStart(
    recorder, 'self-video', runStartedAt, mime, timesliceMs, callbacks.onStarted, deps.log, { videoBitsPerSecond }
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}

/**
 * Acquires the camera stream and starts the self-video recorder.
 * Returns `null` if no camera is available or the run was cancelled during acquisition.
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
  const stream = await acquireSelfVideoStream(
    runId, currentRunId, isStale, recordSelfVideo, recorderSettings, deps, callbacks.onWarning
  );
  if (!stream) return null;
  return startWiredSelfVideoRecorder(stream, suffix, runStartedAt, recorderSettings, deps, callbacks);
}
