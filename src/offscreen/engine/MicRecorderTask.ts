/**
 * @file offscreen/engine/MicRecorderTask.ts
 *
 * Starts, writes, and seals the microphone-only MediaRecorder stream
 * when the run uses `separate` mic mode.
 */

import { getAudioMime, getChunkTimesliceMs } from '../RecorderProfiles';
import { describeMediaError } from '../RecorderSupport';
import { maybeGetMicStream } from '../RecorderCapture';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/extensionSettings';
import type { MicMode } from '../../shared/recording';
import {
  awaitRecorderStart,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
} from './RecorderTaskUtils';
import type { CompletedRecordingArtifact, RecorderEngineDeps } from './RecorderEngineTypes';

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

  const mime = getAudioMime();
  let started = false;
  let actualStartTimeMs = 0;
  const timesliceMs = getChunkTimesliceMs('mic', recorderSettings.chunking);

  const recorder = new MediaRecorder(mic, { mimeType: mime, audioBitsPerSecond: 96_000 });

  const filename = `google-meet-mic-${suffix}-${Date.now()}.webm`;
  const target = await openStorageTarget(filename, mime, deps);

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps);
      callbacks.onStopped(artifact ? { stream: 'mic', artifact } : null);
    } catch (e) {
      deps.error(`${label} finalize/save failed`, describeMediaError(e));
      callbacks.onStopped(null);
    }
  };

  recorder.ondataavailable = makeChunkHandler(target, 'mic', deps);
  recorder.onerror = (e: any) => {
    deps.error('Mic MediaRecorder error', e);
    void finalize('Mic');
  };
  recorder.onstop = () => {
    void finalize('Mic');
  };

  const { actualStartTimeMs: startMs } = await awaitRecorderStart(
    recorder,
    'mic',
    runStartedAt,
    mime,
    timesliceMs,
    callbacks.onStarted,
    deps.log
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}
