/**
 * @file offscreen/engine/RecorderEngineTypes.ts
 *
 * Core type definitions shared across all recorder task files and the engine facade.
 */

import type { RecordingPhase, RecordingStream } from '../../shared/recording';

export type EngineState = Exclude<RecordingPhase, 'failed'>;


export interface SealedStorageFile {
  filename: string;
  file: Blob;
  opfsFilename?: string;
  /** True when the WebM duration fix already ran (e.g. inside the OPFS worker). */
  durationFixed?: boolean;
  cleanup: () => Promise<void>;
}

export interface StorageTarget {
  write(chunk: Blob): Promise<void>;
  close(): Promise<SealedStorageFile | null>;
}

export type CompletedRecordingArtifact = {
  stream: RecordingStream;
  artifact: SealedStorageFile;
};

/**
 * A started MediaRecorder for one stream, held uniformly by the engine so that
 * starting, stopping, ref-counting, and cleanup iterate a single collection
 * instead of touching per-stream fields. `stopStream` is an idempotent eager
 * stop for streams the track owns outright (e.g. the self-video camera).
 */
export interface RecorderTrack {
  readonly stream: RecordingStream;
  readonly recorder: MediaRecorder;
  readonly stopStream?: () => void;
}

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
  notifyPhase: (phase: RecordingPhase) => void;
  reportWarning?: (warning: string) => void;
  openTarget?: (filename: string, stream?: RecordingStream) => Promise<StorageTarget>;
  /**
   * Escalates a persistent storage failure to a protective stop: seals and
   * delivers the already-persisted prefix instead of letting the recorder run
   * on as a phantom REC with nothing landing on disk. Wired to the offscreen
   * finalize pipeline; `reason` is for diagnostics (the user-facing message is
   * emitted via {@link reportWarning} at the call site).
   */
  requestProtectiveStop?: (reason: string) => void;
  /**
   * Stops a single *optional* stream (separate mic / self-video) without ending
   * the session. The engine binds this to itself; it is the RAM-buffer backstop's
   * escalation path — when an optional stream that fell back to RAM grows past its
   * cap, stopping just that stream seals its partial artifact and frees the buffer
   * while the required tab recording keeps running. Never used for `tab`.
   */
  requestStopStream?: (stream: RecordingStream) => void;
};

/**
 * Cap on bytes an {@link InMemoryStorageTarget} may accumulate before it escalates.
 * A RAM buffer is uncapped by nature, leaves nothing on disk for orphan recovery,
 * and lives in the shared offscreen document — so an unbounded one is both
 * genuinely-lost data and an OOM that can take the healthy tab recorder down with
 * it. 512 MB is well under a typical offscreen heap; at the 3 Mbps self-video
 * default that is ~22 min of camera before the stream is stopped and sealed.
 */
export const DEFAULT_MAX_RAM_BUFFER_BYTES = 512 * 1024 * 1024;

export type InMemoryStorageTargetOptions = {
  /** Byte ceiling after which {@link InMemoryStorageTargetOptions.onOverflow} fires once. */
  maxBufferedBytes?: number;
  /** Called once, with the buffered byte total, when the cap is crossed. */
  onOverflow?: (bufferedBytes: number) => void;
};

/** RAM-backed fallback target used when OPFS is unavailable for a stream. */
export class InMemoryStorageTarget implements StorageTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;
  private bufferedBytes = 0;
  private overflowed = false;
  private readonly maxBufferedBytes: number;
  private readonly onOverflow?: (bufferedBytes: number) => void;

  /** Stores filename and MIME so a final File can be assembled on close. */
  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
    options: InMemoryStorageTargetOptions = {},
  ) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_RAM_BUFFER_BYTES;
    this.onOverflow = options.onOverflow;
  }

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory target is closed');
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.size;
    // Unlike OPFS, a RAM buffer has no on-disk file for orphan recovery and grows
    // unbounded toward an OOM of the shared offscreen document. Escalate exactly
    // once when it crosses the cap so the caller can stop+seal this stream.
    if (!this.overflowed && this.bufferedBytes > this.maxBufferedBytes) {
      this.overflowed = true;
      this.onOverflow?.(this.bufferedBytes);
    }
  }

  /** Seals buffered chunks into a File artifact for downstream finalization. */
  async close(): Promise<SealedStorageFile | null> {
    if (this.closed) return null;
    this.closed = true;
    if (!this.chunks.length) return null;

    const file = new File([new Blob(this.chunks, { type: this.mimeType })], this.filename, {
      type: this.mimeType,
    });

    return {
      filename: this.filename,
      file,
      cleanup: async () => {},
    };
  }
}
