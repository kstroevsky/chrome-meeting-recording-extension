/**
 * @file offscreen/engine/TabRecorderTask.ts
 *
 * Starts, writes, and seals the tab audio+video MediaRecorder stream.
 */

import { getChunkTimesliceMs, getTabRecordingProfile } from '../RecorderProfiles';
import { describeMediaError } from '../RecorderSupport';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/settings';
import { resolveTabVideoBitrate, TAB_MAX_FRAME_RATE, TAB_SCREEN_QUALITY_FACTOR, TAB_VIDEO_QUALITY_FACTOR } from '../../shared/settings';
import {
  awaitRecorderStart,
  buildRecordingFilename,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
  stampStartOffset,
} from './RecorderTaskUtils';
import type {
  CompletedRecordingArtifact,
  RecorderEngineDeps,
} from './RecorderEngineTypes';
import { debugPerf } from '../../shared/perf';

export type TabRecorderCallbacks = {
  onStarted: () => void;
  onStopped: (artifact: CompletedRecordingArtifact | null) => void;
  /** Called when the tab MediaRecorder fires onerror, before artifact finalization. */
  onError?: () => void;
};

/**
 * Creates, wires, and starts the tab MediaRecorder.
 * Resolves when the recorder fires `onstart`. The `onStopped` callback is
 * invoked asynchronously after the recorder stops and the artifact is sealed.
 */
export async function startTabRecorder(
  recordingStream: MediaStream,
  suffix: string,
  runStartedAt: number,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  deps: RecorderEngineDeps,
  callbacks: TabRecorderCallbacks
): Promise<MediaRecorder> {
  const encodingProfile = getTabRecordingProfile(
    recorderSettings.tab.output.format,
    recordingStream.getAudioTracks().length > 0,
  );
  if (!encodingProfile) {
    throw new Error(`The selected ${recorderSettings.tab.output.format.toUpperCase()} tab format is unavailable. Change it in Settings and try again.`);
  }
  const mime = encodingProfile.recorderMimeType;
  const timesliceMs = getChunkTimesliceMs('tab', recorderSettings.chunking);
  let started = false;
  let actualStartTimeMs = 0;

  // Scale the reference bitrate against what Chrome actually delivered, not
  // the ceiling constraints we requested. Chrome may capture at a lower
  // resolution (windowed tab, HiDPI mismatch, display scaling) so using the
  // preset dims would overprovision bits for content with fewer pixels.
  const videoTrack = recordingStream.getVideoTracks()[0];
  const ts = videoTrack?.getSettings() ?? {};
  const deliveredWidth = ts.width ?? recorderSettings.tab.output.maxWidth;
  const deliveredHeight = ts.height ?? recorderSettings.tab.output.maxHeight;
  const deliveredFps = Math.min(
    ts.frameRate ?? recorderSettings.tab.output.maxFrameRate,
    TAB_MAX_FRAME_RATE
  );
  const qualityFactor = recorderSettings.tab.output.contentType === 'video'
    ? TAB_VIDEO_QUALITY_FACTOR
    : TAB_SCREEN_QUALITY_FACTOR;
  // Ceiling defaults to the internal MAX_TAB_VIDEO_BITRATE; there is no user knob.
  const videoBitsPerSecond = resolveTabVideoBitrate(
    deliveredWidth,
    deliveredHeight,
    deliveredFps,
    qualityFactor
  );

  // Per-content encoder hint: screen/UI/text wants spatial sharpness (legible
  // text), video/animation wants temporal smoothness. Advisory — MediaRecorder
  // may ignore it; the observed-bitrate ratio in diagnostics tells us if it moved.
  try {
    const videoTrack = recordingStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = recorderSettings.tab.output.contentType === 'video' ? 'motion' : 'text';
    }
  } catch {}

  const recorder = new MediaRecorder(recordingStream, {
    mimeType: mime,
    videoBitsPerSecond,
    audioBitsPerSecond: 96_000,
  });

  const filename = buildRecordingFilename(suffix, 'recording', encodingProfile.extension);
  const target = await openStorageTarget(filename, encodingProfile.contentType, deps, 'tab');

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps, 'tab');
      stampStartOffset(artifact, actualStartTimeMs, runStartedAt);
      if (artifact) {
        callbacks.onStopped({
          stream: 'tab',
          artifact,
        });
      } else {
        callbacks.onStopped(null);
      }
    } catch (e) {
      deps.error(`${label} finalize/save failed`, describeMediaError(e));
      callbacks.onStopped(null);
    }
  };

  recorder.ondataavailable = makeChunkHandler(target, 'tab', deps, videoBitsPerSecond);

  recorder.onerror = (e: any) => {
    deps.error('Tab MediaRecorder error', e);
    debugPerf(deps.log, 'lifecycle', 'recorder_error', { stream: 'tab' });
    callbacks.onError?.();
    void finalize('Tab');
  };

  recorder.onstop = () => {
    void finalize('Tab');
  };

  const { actualStartTimeMs: startMs } = await awaitRecorderStart(
    recorder,
    'tab',
    runStartedAt,
    recorder.mimeType || mime,
    timesliceMs,
    callbacks.onStarted,
    deps.log,
    { format: encodingProfile.format, contentType: encodingProfile.contentType, videoBitsPerSecond, deliveredWidth, deliveredHeight, deliveredFps }
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}
