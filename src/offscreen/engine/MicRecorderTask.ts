/**
 * @file offscreen/engine/MicRecorderTask.ts
 *
 * Starts, writes, and seals the microphone-only MediaRecorder stream
 * when the run uses `separate` mic mode.
 */

import { getChunkTimesliceMs, getMicrophoneRecordingProfile } from '../RecorderProfiles';
import { describeMediaError } from '../RecorderSupport';
import { maybeGetMicStream } from '../RecorderCapture';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/settings';
import type { MicMode } from '../../shared/recording';
import {
  awaitRecorderStart,
  buildRecordingFilename,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
  stampStartOffset,
} from './RecorderTaskUtils';
import type { CompletedRecordingArtifact, RecorderEngineDeps } from './RecorderEngineTypes';
import { debugPerf } from '../../shared/perf';

export type MicRecorderCallbacks = {
  onStarted: () => void;
  onStopped: (artifact: CompletedRecordingArtifact | null) => void;
};

/**
 * Acquires the microphone stream, wires a MediaRecorder against it, and starts
 * recording. Resolves when the recorder fires `onstart`.
 *
 * Returns `null` when the mic stream is unavailable or when the run was
 * cancelled before getUserMedia resolved (stale run detection).
 */
export async function startMicRecorder(
  runId: number,
  currentRunId: () => number,
  isStale: () => boolean,
  suffix: string,
  runStartedAt: number,
  micMode: MicMode,
  recorderSettings: RecorderRuntimeSettingsSnapshot,
  existingMic: MediaStream | null | undefined,
  deps: RecorderEngineDeps,
  callbacks: MicRecorderCallbacks
): Promise<MediaRecorder | null> {
  const mic = existingMic ?? await maybeGetMicStream(micMode, recorderSettings.microphone, deps);

  if (!mic?.getAudioTracks().length || runId !== currentRunId() || isStale()) {
    mic?.getTracks().forEach((t) => t.stop());
    if (mic?.getAudioTracks().length) {
      deps.log('Mic stream obtained after stop; discarding it');
    } else {
      deps.log('Mic stream unavailable; continuing with tab-only recording');
    }
    return null;
  }

  const encodingProfile = getMicrophoneRecordingProfile(recorderSettings.microphone.format);
  if (!encodingProfile) {
    throw new Error(`The selected ${recorderSettings.microphone.format.toUpperCase()} microphone format is unavailable. Change it in Settings and try again.`);
  }
  const mime = encodingProfile.recorderMimeType;
  let started = false;
  let actualStartTimeMs = 0;
  const timesliceMs = getChunkTimesliceMs('mic', recorderSettings.chunking);

  const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 96_000 });

  const filename = buildRecordingFilename(suffix, 'mic', encodingProfile.extension);
  const target = await openStorageTarget(filename, encodingProfile.contentType, deps, 'mic');

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps, 'mic');
      stampStartOffset(artifact, actualStartTimeMs, runStartedAt);
      callbacks.onStopped(artifact
? { stream: 'mic', artifact } : null);
    } catch (e) {
      deps.error(`${label} finalize/save failed`, describeMediaError(e));
      callbacks.onStopped(null);
    }
  };

  recorder.ondataavailable = makeChunkHandler(target, 'mic', deps, 96_000);
  recorder.onerror = (e: any) => {
    deps.error('Mic MediaRecorder error', e);
    debugPerf(deps.log, 'lifecycle', 'recorder_error', { stream: 'mic' });
    void finalize('Mic');
  };
  recorder.onstop = () => {
    void finalize('Mic');
  };

  const { actualStartTimeMs: startMs } = await awaitRecorderStart(
    recorder,
    'mic',
    runStartedAt,
    recorder.mimeType || mime,
    timesliceMs,
    callbacks.onStarted,
    deps.log,
    { format: encodingProfile.format, contentType: encodingProfile.contentType }
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}
