/**
 * @file offscreen/engine/TabRecorderTask.ts
 *
 * Starts, writes, and seals the tab audio+video MediaRecorder stream.
 */

import { getChunkTimesliceMs, getVideoMime } from '../RecorderProfiles';
import { describeMediaError } from '../RecorderSupport';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/extensionSettings';
import { nowMs } from '../../shared/perf';
import {
  awaitRecorderStart,
  buildRecordingFilename,
  makeChunkHandler,
  openStorageTarget,
  sealAndFixArtifact,
} from './RecorderTaskUtils';
import type {
  CompletedRecordingArtifact,
  RecorderEngineDeps,
  SealedStorageFile,
} from './RecorderEngineTypes';

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
  const mime = getVideoMime();
  const timesliceMs = getChunkTimesliceMs('tab', recorderSettings.chunking);
  let started = false;
  let actualStartTimeMs = 0;

  const recorder = new MediaRecorder(recordingStream, {
    mimeType: mime,
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 96_000,
  });

  const filename = buildRecordingFilename(suffix, 'recording');
  const target = await openStorageTarget(filename, mime, deps);

  const finalize = async (label: string) => {
    try {
      const artifact = await sealAndFixArtifact(target, started, actualStartTimeMs, label, deps);
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

  recorder.ondataavailable = makeChunkHandler(target, 'tab', deps);

  recorder.onerror = (e: any) => {
    deps.error('Tab MediaRecorder error', e);
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
    mime,
    timesliceMs,
    callbacks.onStarted,
    deps.log
  );
  started = true;
  actualStartTimeMs = startMs;

  return recorder;
}
