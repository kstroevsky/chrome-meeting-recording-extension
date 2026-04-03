/**
 * @file offscreen/TabArtifactPostprocessor.ts
 *
 * Best-effort fallback that replays a sealed tab artifact, downscales it
 * through the canvas-based resizer, and returns a replacement file for the
 * final save/upload step.
 */

import { getChunkingSettings } from '../shared/extensionSettings';
import { nowMs } from '../shared/perf';
import type { RecordingArtifactFinalizePlan, SealedStorageFile } from './RecorderEngine';
import { LocalFileTarget } from './LocalFileTarget';
import { getVideoMime } from './RecorderProfiles';
import { describeMediaError } from './RecorderSupport';
import { createResizedVideoStream, readStreamVideoMetrics } from './RecorderVideoResizer';
import {
  cleanupTempOpfsFile,
  formatMetrics,
  preparePlaybackElement,
  stopStream,
  waitForRecorderStart,
  waitForVideoMetadata,
} from './postprocessor/VideoPlaybackElement';
import ysFixWebmDuration from 'fix-webm-duration';

type TabArtifactPostprocessorDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

/** RAM-backed fallback target when OPFS is unavailable during postprocessing. */
class InMemoryPostprocessTarget {
  private readonly chunks: Blob[] = [];
  private closed = false;

  constructor(private readonly filename: string, private readonly mimeType: string) {}

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('In-memory postprocess target is closed');
    this.chunks.push(chunk);
  }

  async close(): Promise<SealedStorageFile | null> {
    if (this.closed) return null;
    this.closed = true;
    if (!this.chunks.length) return null;
    return {
      filename: this.filename,
      file: new File([new Blob(this.chunks, { type: this.mimeType })], this.filename, { type: this.mimeType }),
      cleanup: async () => {},
    };
  }
}

/**
 * Owns the full postprocessing resource lifecycle: stream acquisition,
 * recording, and ordered teardown. Separates setup from recording so that
 * cleanup is always called by the caller regardless of which phase failed.
 */
class PostprocessingSession {
  private readonly inputUrl: string;
  private readonly tempFilename: string;

  private playbackVideo: HTMLVideoElement | null = null;
  private playbackStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private cleanupProcessedStream: (() => void) | null = null;
  private outputTarget: LocalFileTarget | InMemoryPostprocessTarget | null = null;
  private usingOpfsTarget = false;

  constructor(
    private readonly artifact: SealedStorageFile,
    private readonly finalize: RecordingArtifactFinalizePlan,
    private readonly deps: TabArtifactPostprocessorDeps,
    private readonly mimeType: string,
    private readonly chunkingDefaultTimesliceMs: number,
  ) {
    this.inputUrl = URL.createObjectURL(artifact.file);
    this.tempFilename = `tab-postprocess-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`;
  }

  /** Acquires and validates all streams, then opens the storage target. */
  async setup(): Promise<void> {
    this.playbackVideo = document.createElement('video');
    preparePlaybackElement(this.playbackVideo);
    this.playbackVideo.src = this.inputUrl;
    await waitForVideoMetadata(this.playbackVideo);

    await this.playbackVideo.play();
    this.playbackStream = this.capturePlaybackStream(this.playbackVideo);

    const resized = await createResizedVideoStream(this.playbackStream, this.finalize.outputTarget);
    this.processedStream = resized.stream;
    this.cleanupProcessedStream = resized.cleanup;
    this.validateOutputMetrics();

    this.playbackVideo.pause();
    try { this.playbackVideo.currentTime = 0; } catch {}

    await this.openOutputTarget();
  }

  /** Re-encodes the processed stream into the output target and returns the sealed artifact. */
  async record(): Promise<SealedStorageFile> {
    const recorder = new MediaRecorder(this.processedStream!, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });

    let writeFailed = false;
    let actualStartTimeMs = 0;

    return new Promise<SealedStorageFile>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = async () => {
        if (settled) return;
        settled = true;
        try {
          const sealed = await this.outputTarget!.close();
          if (!sealed) { reject(new Error('Tab postprocess produced no output artifact')); return; }
          if (actualStartTimeMs > 0) {
            try {
              sealed.file = await ysFixWebmDuration(sealed.file, nowMs() - actualStartTimeMs, { logger: false });
            } catch (fixErr) {
              this.deps.warn('Tab postprocess duration fix failed', fixErr);
            }
          }
          resolve({ ...sealed, filename: this.artifact.filename });
        } catch (error) { reject(error); }
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data?.size) return;
        void this.outputTarget!.write(event.data).catch((error) => {
          writeFailed = true;
          fail(new Error(`Tab postprocess write failed: ${describeMediaError(error)}`));
        });
      };
      recorder.onerror = (event: any) => fail(new Error(`Tab postprocess MediaRecorder failed: ${describeMediaError(event)}`));
      recorder.onstop = () => { if (!writeFailed) void succeed(); };
      this.playbackVideo!.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') try { recorder.stop(); } catch (error) { fail(error); }
      }, { once: true });

      // Start recorder and playback inside the executor so event handlers are
      // active before any data arrives, preventing the irresolvable deadlock
      // where the promise waits for onstop but the recorder was never started.
      waitForRecorderStart(recorder)
        .then(() => { actualStartTimeMs = nowMs(); return this.playbackVideo!.play(); })
        .catch(fail);
      try { recorder.start(this.chunkingDefaultTimesliceMs); } catch (error) { fail(error); }
    });
  }

  /**
   * Releases all acquired resources in the correct order.
   * On failure, also removes the temporary OPFS file if one was created.
   */
  async cleanup(succeeded: boolean): Promise<void> {
    if (!succeeded && this.usingOpfsTarget) {
      try {
        await cleanupTempOpfsFile(this.tempFilename);
      } catch (cleanupError) {
        this.deps.warn('Failed to cleanup temporary postprocess file', this.tempFilename, describeMediaError(cleanupError));
      }
    }
    this.cleanupProcessedStream?.();
    stopStream(this.playbackStream);
    if (this.processedStream && this.processedStream !== this.playbackStream) stopStream(this.processedStream);
    if (this.playbackVideo) {
      try { this.playbackVideo.pause(); } catch {}
      this.playbackVideo.src = '';
      this.playbackVideo.load();
    }
    URL.revokeObjectURL(this.inputUrl);
  }

  private capturePlaybackStream(video: HTMLVideoElement): MediaStream {
    const captureStream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
    if (typeof captureStream !== 'function') {
      throw new Error('HTMLVideoElement.captureStream() is unavailable for tab postprocess');
    }
    const stream = captureStream.call(video);
    if (!stream.getVideoTracks().length) {
      throw new Error('Playback capture did not produce a video track for tab postprocess');
    }
    return stream;
  }

  private validateOutputMetrics(): void {
    const metrics = readStreamVideoMetrics(this.processedStream!);
    const target = this.finalize.outputTarget;
    if (
      metrics.width !== target.width
      || metrics.height !== target.height
      || (typeof metrics.frameRate === 'number' && metrics.frameRate > target.frameRate + 0.5)
    ) {
      throw new Error(
        `Tab postprocess produced ${formatMetrics(metrics.width, metrics.height, metrics.frameRate)} `
        + `instead of ${formatMetrics(target.width, target.height, target.frameRate)}`
      );
    }
  }

  private async openOutputTarget(): Promise<void> {
    try {
      this.outputTarget = await LocalFileTarget.create(this.tempFilename);
      this.usingOpfsTarget = true;
    } catch (error) {
      this.deps.warn('Failed to open postprocess storage target, falling back to RAM buffer', describeMediaError(error));
      this.outputTarget = new InMemoryPostprocessTarget(this.tempFilename, this.mimeType);
    }
  }
}

/**
 * Replays one sealed tab artifact and returns a replacement artifact at the
 * requested final output target. Throws on any fallback-processing failure.
 */
export async function postprocessTabArtifact(
  artifact: SealedStorageFile,
  finalize: RecordingArtifactFinalizePlan,
  deps: TabArtifactPostprocessorDeps
): Promise<SealedStorageFile> {
  const { defaultTimesliceMs } = getChunkingSettings();
  const session = new PostprocessingSession(artifact, finalize, deps, getVideoMime(), defaultTimesliceMs);

  let processedArtifact: SealedStorageFile;
  try {
    await session.setup();
    processedArtifact = await session.record();
  } catch (error) {
    await session.cleanup(false);
    throw error;
  }
  await session.cleanup(true);

  try {
    await artifact.cleanup();
  } catch (error) {
    deps.warn('Failed to cleanup original tab artifact after postprocess', artifact.filename, describeMediaError(error));
  }

  deps.log('tab artifact postprocess complete:', {
    filename: artifact.filename,
    targetWidth: finalize.outputTarget.width,
    targetHeight: finalize.outputTarget.height,
    targetFrameRate: finalize.outputTarget.frameRate,
  });
  return processedArtifact;
}
