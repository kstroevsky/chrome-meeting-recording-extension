/**
 * @file offscreen/engine/RecorderTaskUtils.ts
 *
 * Shared utilities used by tab, mic, and self-video recorder tasks:
 * storage target opening, chunk write handlers, and start/stop accounting.
 */

import { describeMediaError } from '../RecorderSupport';
import { debugPerf, logPerf, nowMs, roundMs } from '../../shared/perf';
import { TIMEOUTS } from '../../shared/timeouts';
import { WriteBackpressure } from '../storage/WriteBackpressure';
import type { RecorderEngineDeps, SealedStorageFile, StorageTarget } from './RecorderEngineTypes';
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
  deps: Pick<RecorderEngineDeps, 'warn' | 'openTarget'>,
  stream?: RecordingStream
): Promise<StorageTarget> {
  if (!deps.openTarget) return new InMemoryStorageTarget(filename, mimeType);

  try {
    return await deps.openTarget(filename, stream);
  } catch (e) {
    deps.warn('Failed to open storage target, falling back to RAM buffer', describeMediaError(e));
    return new InMemoryStorageTarget(filename, mimeType);
  }
}

/**
 * Consecutive write rejections tolerated before a stream is treated as
 * persistently broken and escalated to a protective stop. A small count rides
 * out a transient blip; at the tab cadence (~4 s) this is ~12 s of dead writes
 * before sealing — and the already-persisted prefix is safe the whole time.
 */
const MAX_CONSECUTIVE_WRITE_FAILURES = 3;

/** Creates an ondataavailable handler that writes chunks to the target and logs perf events. */
export function makeChunkHandler(
  target: StorageTarget,
  stream: RecordingStream,
  deps: Pick<RecorderEngineDeps, 'log' | 'error' | 'reportWarning' | 'requestProtectiveStop'>
): (e: BlobEvent) => void {
  let consecutiveWriteFailures = 0;
  let escalated = false;

  // Escalate a persistent storage failure (repeated write rejections, or a
  // write backlog past the hard ceiling) to a protective stop: warn the user and
  // ask the engine to seal+deliver the already-persisted prefix, rather than let
  // the recorder run on as a phantom REC with nothing reaching disk. Fires at
  // most once per stream; the engine de-dupes the stop across streams.
  const escalate = (reason: string): void => {
    if (escalated) return;
    escalated = true;
    deps.reportWarning?.(reason);
    deps.requestProtectiveStop?.(reason);
  };

  // Bound the write queue: if storage falls behind, un-written chunks pile up in
  // RAM, so surface a throttled warning (and diagnostics) before the hard ceiling
  // forces a protective stop instead of OOMing.
  const backpressure = new WriteBackpressure({
    onWarn: (info) => {
      deps.reportWarning?.(
        `Recording is writing to disk slower than it is captured (${stream}); your storage may be slow `
        + `and the recording could be at risk.`
      );
      debugPerf(deps.log, 'storage', 'write_backpressure', {
        stream,
        pendingBytes: info.pendingBytes,
        pendingChunks: info.pendingChunks,
        peakPendingBytes: info.peakPendingBytes,
        warnCount: info.warnCount,
      });
    },
    onCeiling: (info) => {
      debugPerf(deps.log, 'storage', 'write_backpressure_ceiling', {
        stream,
        pendingBytes: info.pendingBytes,
        pendingChunks: info.pendingChunks,
        peakPendingBytes: info.peakPendingBytes,
      });
      escalate(
        `Recording stopped to protect your data: the ${stream} stream fell too far behind on disk `
        + `(${Math.round(info.pendingBytes / 1024 / 1024)} MB unwritten). The recording up to this point was saved.`
      );
    },
  });

  return (e: BlobEvent) => {
    if (!e.data?.size) return;
    const bytes = e.data.size;
    const writeStartedAt = nowMs();
    backpressure.enqueue(bytes);
    void target.write(e.data)
      .then(() => {
        consecutiveWriteFailures = 0;
        const durationMs = roundMs(nowMs() - writeStartedAt);
        debugPerf(deps.log, 'recorder', 'chunk_persisted', {
          stream,
          chunkBytes: bytes,
          durationMs,
          throughputMbps: durationMs > 0
            ? Math.round(((bytes / 1024 / 1024) / (durationMs / 1000)) * 10) / 10
            : null,
        });
      })
      .catch((err) => {
        consecutiveWriteFailures += 1;
        deps.error(`${stream} target write error`, describeMediaError(err));
        if (consecutiveWriteFailures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
          escalate(
            `Recording stopped to protect your data: the ${stream} stream could no longer be saved to disk `
            + `(${consecutiveWriteFailures} consecutive write failures). The recording up to this point was saved.`
          );
        }
      })
      .finally(() => backpressure.complete(bytes));
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
  deps: Pick<RecorderEngineDeps, 'warn' | 'error' | 'log'>,
  stream: RecordingStream
): Promise<SealedStorageFile | null> {
  const sealStartedAt = nowMs();
  const artifact = await target.close();
  if (!artifact) return null;
  // The OPFS worker fixes duration in-thread on close (artifact.durationFixed).
  // Only the rare non-worker fallback (LocalFileTarget / RAM) reaches here, where
  // we dynamic-import the fixer so webm-duration-fix stays out of offscreen.js.
  if (!artifact.durationFixed && started && actualStartTimeMs > 0) {
    try {
      const { default: fixWebmDuration } = await import('webm-duration-fix');
      artifact.file = await fixWebmDuration(artifact.file);
    } catch (e) {
      deps.warn(`${label} duration fix failed`, e);
    }
  }
  debugPerf(deps.log, 'recorder', 'artifact_sealed', {
    stream,
    durationMs: roundMs(nowMs() - sealStartedAt),
    artifactBytes: artifact.file.size,
    // True only when the OPFS worker fixed duration in-thread (not the main-thread fallback).
    durationFixedInWorker: artifact.durationFixed === true,
  });
  return artifact;
}
