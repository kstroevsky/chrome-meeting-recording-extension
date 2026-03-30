/**
 * @file offscreen/RecorderAudio.ts
 *
 * Audio-specific helpers used by `RecorderEngine` for microphone mixing and
 * local playback restoration.
 */

import { describeMediaError } from './RecorderSupport';

type RecorderAudioDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
};

export class MixedAudioMixer {
  private ctx: AudioContext | null = null;
  private sources: MediaStreamAudioSourceNode[] = [];

  /** Creates a mixer that can combine tab and microphone audio into one stream. */
  constructor(private readonly deps: RecorderAudioDeps) {}

  /** Returns a new stream containing the original tab video plus mixed audio tracks. */
  async create(tabStream: MediaStream, micStream: MediaStream): Promise<MediaStream> {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new AC();
    this.ctx = ctx;

    await ctx.resume().catch(() => {});
    const destination = ctx.createMediaStreamDestination();

    const connectStream = (stream: MediaStream) => {
      if (!stream.getAudioTracks().length) return;
      const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      source.connect(destination);
      this.sources.push(source);
    };

    connectStream(tabStream);
    connectStream(micStream);

    const mixedTracks = [
      ...tabStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ];
    this.deps.log('Created mixed tab+microphone recording stream');
    return new MediaStream(mixedTracks);
  }

  /** Disconnects audio graph nodes and closes the underlying AudioContext. */
  stop() {
    for (const source of this.sources) {
      try {
        source.disconnect();
      } catch {}
    }
    this.sources = [];

    try {
      this.ctx?.close();
    } catch {}
    this.ctx = null;
  }
}

export class AudioPlaybackBridge {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  /** Creates a helper that replays captured tab audio locally when Chrome suppresses it. */
  constructor(private readonly deps: RecorderAudioDeps) {}

  /** Connects a captured audio track back to the speaker output. */
  async start(track: MediaStreamTrack): Promise<void> {
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new AC();
      this.ctx = ctx;

      await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      this.source = src;

      src.connect(ctx.destination);
      this.deps.log('Re-routed captured tab audio back to speakers');
    } catch (error) {
      this.deps.warn('Audio playback bridge failed (non-fatal)', describeMediaError(error));
      this.stop();
    }
  }

  /** Disconnects the playback bridge and closes the AudioContext. */
  stop() {
    try {
      this.source?.disconnect();
    } catch {}
    this.source = null;

    try {
      this.ctx?.close();
    } catch {}
    this.ctx = null;
  }
}
