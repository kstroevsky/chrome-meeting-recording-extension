/**
 * @file offscreen/engine/RecorderEngineTypes.ts
 *
 * Core type definitions shared across all recorder task files and the engine facade.
 */

import type { RecordingPhase, RecordingStream } from '../../shared/recording';
import type { VideoResizeTarget } from '../RecorderVideoResizer';

export type RecordingStateExtra = Record<string, any> | undefined;
export type EngineState = 'idle' | 'starting' | 'recording' | 'stopping';

export type PreparedTabRecorderStream = {
  stream: MediaStream;
  finalize?: RecordingArtifactFinalizePlan;
};

export interface SealedStorageFile {
  filename: string;
  file: Blob;
  opfsFilename?: string;
  cleanup: () => Promise<void>;
}

export interface StorageTarget {
  write(chunk: Blob): Promise<void>;
  close(): Promise<SealedStorageFile | null>;
}

export type RecordingArtifactFinalizePlan = {
  outputTarget: VideoResizeTarget;
  liveResized: boolean;
  requiresPostprocess: boolean;
};

export type CompletedRecordingArtifact = {
  stream: RecordingStream;
  artifact: SealedStorageFile;
  finalize?: RecordingArtifactFinalizePlan;
};

export type RecorderEngineDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
  notifyPhase: (phase: RecordingPhase, extra?: RecordingStateExtra) => void;
  reportWarning?: (warning: string) => void;
  openTarget?: (filename: string) => Promise<StorageTarget>;
};

/** RAM-backed fallback target used when OPFS is unavailable for a stream. */
export class InMemoryStorageTarget implements StorageTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;

  /** Stores filename and MIME so a final File can be assembled on close. */
  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
  ) {}

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory target is closed');
    this.chunks.push(chunk);
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
