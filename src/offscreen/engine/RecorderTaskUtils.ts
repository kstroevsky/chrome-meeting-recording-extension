/**
 * @file offscreen/engine/RecorderTaskUtils.ts
 *
 * Shared utilities used by tab, mic, and self-video recorder tasks:
 * storage target opening, chunk write handlers, and start/stop accounting.
 */

import { describeMediaError } from '../RecorderSupport';
import { debugPerf, logPerf, nowMs, roundMs } from '../../shared/perf';
import { TIMEOUTS } from '../../shared/timeouts';
import ysFixWebmDuration from 'fix-webm-duration';
import type { CompletedRecordingArtifact, RecorderEngineDeps, SealedStorageFile, StorageTarget } from './RecorderEngineTypes';
import { InMemoryStorageTarget } from './RecorderEngineTypes';
import type { RecordingStream } from '../../shared/recording';

/**
 * Formats the current time as a filesystem-safe UTC datetime string:
 * `YYYYMMDDTHHmmssZ` — no colons or slashes that would break file paths.
 */
function utcDatetimeStamp(date = new Date()): string {
  // Format: YYYYMMDDTHHmm  (UTC, no seconds)
  return date.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''));
}

/**
 * Builds a recording filename using the format:
 * `google-meet-{slug}-{UTC-datetime}-{type}.webm`
 *
 * Example: `google-meet-abc123de-20260402T083000Z-recording.webm`
 */
export function buildRecordingFilename(slug: string, type: 'recording' | 'mic' | 'self-video'): string {
  const slugPart = slug ? `${slug}-` : '';
  return `google-meet-${slugPart}${utcDatetimeStamp()}-${type}.webm`;
}

/** Opens the preferred storage target and falls back to RAM buffering on failure. */
export async function openStorageTarget(
  filename: string,
  mimeType: string,
  deps: Pick<RecorderEngineDeps, 'warn' | 'openTarget'>
): Promise<StorageTarget> {
  if (!deps.openTarget) return new InMemoryStorageTarget(filename, mimeType);

  try {
    return await deps.openTarget(filename);
  } catch (e) {
    deps.warn('Failed to open storage target, falling back to RAM buffer', describeMediaError(e));
    return new InMemoryStorageTarget(filename, mimeType);
  }
}

/** Creates an ondataavailable handler that writes chunks to the target and logs perf events. */
export function makeChunkHandler(
  target: StorageTarget,
  stream: RecordingStream,
  deps: Pick<RecorderEngineDeps, 'log' | 'error'>
): (e: BlobEvent) => void {
  return (e: BlobEvent) => {
    if (!e.data?.size) return;
    const writeStartedAt = nowMs();
    void target.write(e.data)
      .then(() => {
        debugPerf(deps.log, 'recorder', 'chunk_persisted', {
          stream,
          chunkBytes: e.data.size,
          durationMs: roundMs(nowMs() - writeStartedAt),
        });
      })
      .catch((err) => deps.error(`${stream} target write error`, describeMediaError(err)));
  };
}

/**
 * Waits for a MediaRecorder to fire `onstart` and resolves.
 * Rejects with a timeout error if the recorder does not start in time.
 */
export async function awaitRecorderStart(
  recorder: MediaRecorder,
  stream: RecordingStream,
  runStartedAt: number,
  mime: string,
  timesliceMs: number,
  onStarted: () => void,
  log: (...a: any[]) => void,
  extraLogFields?: Record<string, unknown>
): Promise<{ actualStartTimeMs: number }> {
  return new Promise((resolve, reject) => {
    const startTimeout = setTimeout(
      () => reject(new Error(`${stream} MediaRecorder did not start (timeout)`)),
      TIMEOUTS.RECORDER_START_MS
    );

    recorder.onstart = () => {
      clearTimeout(startTimeout);
      const actualStartTimeMs = nowMs();
      onStarted();
      logPerf(log, 'recorder', 'recorder_started', {
        stream,
        latencyMs: roundMs(nowMs() - runStartedAt),
        mime,
        timesliceMs,
        ...extraLogFields,
      });
      log(`${stream} MediaRecorder started`);
      resolve({ actualStartTimeMs });
    };

    recorder.start(timesliceMs);
  });
}

/**
 * Seals a storage target, optionally patches WebM duration, and returns the
 * completed artifact. Should be called from a recorder's `onstop` handler.
 */
export async function sealAndFixArtifact(
  target: StorageTarget,
  started: boolean,
  actualStartTimeMs: number,
  label: string,
  deps: Pick<RecorderEngineDeps, 'warn' | 'error'>
): Promise<SealedStorageFile | null> {
  const artifact = await target.close();
  if (!artifact) return null;
  if (started && actualStartTimeMs > 0) {
    try {
      const durationMs = nowMs() - actualStartTimeMs;
      artifact.file = await ysFixWebmDuration(artifact.file, durationMs, { logger: false });
    } catch (e) {
      deps.warn(`${label} duration fix failed`, e);
    }
  }
  return artifact;
}

/** Pushes a completed artifact into the finalized list or logs a finalization failure. */
export async function finalizeArtifact(
  getArtifact: () => Promise<SealedStorageFile | null>,
  stream: RecordingStream,
  finalizedArtifacts: CompletedRecordingArtifact[],
  label: string,
  deps: Pick<RecorderEngineDeps, 'error'>,
  extraFields?: Omit<CompletedRecordingArtifact, 'stream' | 'artifact'>
): Promise<void> {
  try {
    const artifact = await getArtifact();
    if (artifact) {
      finalizedArtifacts.push({ stream, artifact, ...extraFields });
    }
  } catch (e) {
    deps.error(`${label} finalize/save failed`, describeMediaError(e));
  }
}
